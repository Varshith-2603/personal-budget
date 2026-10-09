package com.aditya.personalbudget.service;

import com.aditya.personalbudget.domain.entity.Account;
import com.aditya.personalbudget.domain.entity.Category;
import com.aditya.personalbudget.domain.entity.HostedChit;
import com.aditya.personalbudget.domain.entity.HostedChitMember;
import com.aditya.personalbudget.domain.entity.HostedChitMonth;
import com.aditya.personalbudget.domain.entity.HostedChitPayment;
import com.aditya.personalbudget.domain.entity.JournalEntry;
import com.aditya.personalbudget.domain.type.AccountClass;
import com.aditya.personalbudget.domain.type.AccountType;
import com.aditya.personalbudget.domain.type.CategoryKind;
import com.aditya.personalbudget.domain.type.VoucherType;
import com.aditya.personalbudget.exception.BusinessException;
import com.aditya.personalbudget.exception.NotFoundException;
import com.aditya.personalbudget.repository.AccountRepository;
import com.aditya.personalbudget.repository.JournalLineRepository;
import com.aditya.personalbudget.repository.CategoryRepository;
import com.aditya.personalbudget.repository.HostedChitMemberRepository;
import com.aditya.personalbudget.repository.HostedChitMonthRepository;
import com.aditya.personalbudget.repository.HostedChitPaymentRepository;
import com.aditya.personalbudget.repository.HostedChitRepository;
import com.aditya.personalbudget.repository.HostedChitShareRepository;
import com.aditya.personalbudget.repository.HostedChitAgreementRepository;
import com.aditya.personalbudget.repository.AttachmentRepository;
import com.aditya.personalbudget.domain.entity.HostedChitAgreement;
import com.aditya.personalbudget.domain.entity.HostedChitShare;
import com.aditya.personalbudget.dto.PlanningDtos.CategoryRequest;
import com.aditya.personalbudget.repository.JournalEntryRepository;
import com.aditya.personalbudget.security.UserContext;
import com.aditya.personalbudget.storage.ConcurrentUpdateException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.YearMonth;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * Chits the user runs as the organiser (see {@link HostedChit}): members, the monthly schedule, collections,
 * the winner of each month and the payout.
 * <p>
 * Model, for month m (1..months): chit value = base value + (m - 1) x monthly increment, payout = chit value -
 * commission. Months are closed in order: the <i>current</i> month is the first one whose payout is not done; its
 * winner is picked (from members who have not won yet), then the payout is marked done, which locks the winner.
 * <p>
 * Two kinds of chit: FIXED (the chit value grows by a fixed step, the winner is picked or drawn, and winners may
 * pay an extra amount afterwards) and AUCTION (Margadarsi style: the chit value is fixed, members bid a discount,
 * the commission comes out of it and the rest is the dividend, so everyone pays installment - dividend).
 * <p>
 * Books (only when the chit's {@code postToBooks} is on):
 * <ul>
 *   <li><b>Collection</b>: Dr collection account / Cr Hosted Chit Funds (a liability: the members' money, held)</li>
 *   <li><b>Payout</b>: Dr Hosted Chit Funds / Cr collection account ("Chit payout - member")</li>
 *   <li><b>Commission</b>: Dr Hosted Chit Funds / Cr Income [the chosen category] ("Chit commission - chit"), and,
 *       when the commission has its own account, Dr commission account / Cr collection account</li>
 * </ul>
 * The collection and commission accounts can be existing ones or separate accounts made for the chit.
 * so the balance sheet shows what is held (collected and not yet paid out) as a liability, and only the commission
 * is income. Every change writes its own activity line (the generic recorder skips these calls).
 */
@Service
public class HostedChitService {

    public static final String SOURCE_COLLECTION = "HOSTED_CHIT_COLLECTION";
    public static final String SOURCE_PAYOUT = "HOSTED_CHIT_PAYOUT";
    public static final String SOURCE_COMMISSION = "HOSTED_CHIT_COMMISSION";
    static final String FUNDS_ACCOUNT = "Hosted Chit Funds";
    static final String COMMISSION_CATEGORY = "Chit Commission Income";
    static final String LATE_FEE_CATEGORY = "Chit Late Payment Interest";
    private static final String AREA = "Host a Chit";
    private static final Set<String> MODES = Set.of("Cash", "UPI", "Bank");
    static final String EXTRA_NONE = "NONE";
    static final String EXTRA_PERCENT = "PERCENT";
    static final String EXTRA_FIXED = "FIXED";

    // ================================================================== requests

    public record MemberInput(@NotBlank @Size(max = 100) String name, @Size(max = 20) String phone,
                              @jakarta.validation.constraints.Email @Size(max = 120) String email) {
    }

    /** The organiser's signature for receipts (an SVG path in a 1000 x 300 box) and the name under it; blank removes it. */
    public record SignatureRequest(@Size(max = 20000) String signature, @Size(max = 100) String signer) {
    }

    public record ChitRequest(
            @NotBlank @Size(max = 100) String name,
            /* FIXED or AUCTION (only when creating) */
            String chitType,
            @NotNull LocalDate startMonth,
            @Min(1) @Max(28) Integer dueDay,
            @NotNull @Min(2) @Max(100) Integer memberCount,
            @NotNull @Min(2) @Max(100) Integer months,
            /* fixed chits; auction chits work it out (chit value / members) */
            @PositiveOrZero BigDecimal installment,
            @NotNull @Positive BigDecimal baseValue,
            @NotNull @PositiveOrZero BigDecimal monthlyIncrement,
            @NotNull @PositiveOrZero BigDecimal commission,
            /* winners pay extra after winning: NONE, PERCENT (of the chit value) or FIXED */
            String winnerExtraType,
            @PositiveOrZero BigDecimal winnerExtraValue,
            /* auction chits: the highest discount a member may bid, % of the chit value */
            @PositiveOrZero BigDecimal maxBidPercent,
            /* late payment interest, % a month, and the days of grace before it starts */
            @PositiveOrZero BigDecimal lateFeePercent,
            @Min(0) @Max(60) Integer lateGraceDays,
            /* the organiser's UPI ID and name, for payment links */
            @Size(max = 60) String upiId,
            @Size(max = 100) String payeeName,
            Boolean postToBooks,
            Long accountId,
            /* make a separate account for this chit's collections (instead of accountId) */
            Boolean separateCollectionAccount,
            Long commissionAccountId,
            /* make a separate account for the commission (instead of commissionAccountId) */
            Boolean separateCommissionAccount,
            Long commissionCategoryId,
            /* late payment interest: an existing account, or a separate one made for the chit */
            Long lateFeeAccountId,
            Boolean separateLateFeeAccount,
            @Size(max = 255) String notes,
            /* only when creating: the members, in order */
            List<@Valid MemberInput> members,
            Long version) {
    }

    /** amount: towards the installment; lateFee: late interest collected; lateFeeWaived: late interest let off. */
    public record PaymentRequest(@NotNull Long memberId, @NotNull @Min(1) Integer monthNo, @NotNull @PositiveOrZero BigDecimal amount,
                                 @PositiveOrZero BigDecimal lateFee, @PositiveOrZero BigDecimal lateFeeWaived,
                                 @Size(max = 60) String reference,
                                 LocalDate paidDate, String mode, @Size(max = 255) String note,
                                 /* the user confirmed a payment above the installment */
                                 Boolean allowExcess, Long version) {
    }

    public record CollectAllRequest(LocalDate paidDate, String mode) {
    }

    /** bid: auction chits, the winning bid (the discount the winner gives up). */
    public record WinnerRequest(@NotNull Long memberId, Boolean random, @PositiveOrZero BigDecimal bid) {
    }

    public record PayoutRequest(LocalDate payoutDate, String mode, @Size(max = 60) String reference,
                                /* the user confirmed closing the month with unpaid dues */
                                Boolean allowDues,
                                /* also make the winner's digital agreement */
                                Boolean createAgreement, @Size(max = 100) String guarantorName, @Size(max = 20) String guarantorPhone) {
    }

    public record AgreementRequest(@Size(max = 100) String guarantorName, @Size(max = 20) String guarantorPhone,
                                   @Size(max = 6000) String terms) {
    }

    // ================================================================== views

    public record ChitView(Long id, String name, String chitType, LocalDate startMonth, int dueDay, int memberCount, int months,
                           BigDecimal installment, BigDecimal baseValue, BigDecimal monthlyIncrement, BigDecimal commission,
                           String winnerExtraType, BigDecimal winnerExtraValue, BigDecimal winnerExtraAmount,
                           BigDecimal maxBidPercent, BigDecimal minBid, BigDecimal maxBid,
                           BigDecimal lateFeePercent, int lateGraceDays, String upiId, String payeeName,
                           String receiptSignature, String receiptSigner,
                           BigDecimal lateFeesCollected, BigDecimal lateFeesDue,
                           boolean postToBooks, Long accountId, String accountName, Long commissionAccountId,
                           String commissionAccountName, Long commissionCategoryId, String commissionCategoryName,
                           Long lateFeeAccountId, String lateFeeAccountName,
                           String status, boolean demo, String notes,
                           int currentMonth, int completedMonths, BigDecimal currentChitValue,
                           BigDecimal collectedThisMonth, BigDecimal expectedThisMonth, int paidThisMonth,
                           BigDecimal totalCollected, BigDecimal totalPaidOut, BigDecimal commissionEarned,
                           BigDecimal pendingDues, int pendingCount, BigDecimal held, LocalDate nextDueDate,
                           boolean structureLocked, String createdBy, LocalDateTime createdAt, Long version) {
    }

    public record MemberView(Long id, int slot, String name, String phone, String email, Integer wonMonth,
                             BigDecimal totalPaid, BigDecimal balanceDue, BigDecimal lateFeeDue, Long version) {
    }

    /**
     * status: COMPLETED (payout done), ONGOING (the current month) or UPCOMING. Auction chits: bid and dividend once
     * the auction is recorded; until then payout is the most the winner could get ({@code estimated}).
     */
    public record MonthView(Long id, int monthNo, LocalDate dueDate, BigDecimal installment, BigDecimal chitValue,
                            BigDecimal payout, boolean estimated, BigDecimal bid, BigDecimal dividend,
                            BigDecimal commission, Long winnerMemberId, String winnerName, String drawMethod,
                            String status, boolean due, BigDecimal collected, BigDecimal expected, int paidCount,
                            LocalDate payoutDate, String payoutMode, String payoutReference, String payoutEntryNo,
                            Long payoutEntryId, Long version) {
    }

    public record PaymentView(Long id, Long memberId, String memberName, int monthNo, BigDecimal amount, BigDecimal lateFee,
                              BigDecimal lateFeeWaived, String reference, String receiptNo, LocalDate paidDate,
                              String mode, String note, String entryNo, Long journalEntryId, int attachmentCount,
                              String createdBy, LocalDateTime createdAt, Long version) {
    }

    /** Late interest on one member's month: accrued so far, collected or let off, still due. */
    public record LateFeeView(Long memberId, int monthNo, int daysLate, BigDecimal accrued, BigDecimal settled, BigDecimal due) {
    }

    /** status: DRAFT (made, not yet accepted), ACCEPTED (by the member through the link) or SIGNED (on paper). */
    public record AgreementView(Long id, int monthNo, Long memberId, String memberName, String agreementNo, BigDecimal chitValue,
                                BigDecimal deduction, BigDecimal payoutAmount, LocalDate payoutDate, String payoutMode,
                                String payoutReference, Integer remainingInstallments, BigDecimal remainingAmount,
                                String guarantorName, String guarantorPhone, String terms, String contentHash, String status,
                                String acceptedName, LocalDateTime acceptedAt, String acceptedFrom, String acceptedPhone,
                                Boolean phoneMatches, String acceptedIp, String acceptedDevice, String deviceHash, String acceptedLocation,
                                String signature, String acceptanceSeal, LocalDateTime createdAt) {
    }

    /**
     * kind: COLLECTION (paymentId set), PAYOUT or COMMISSION; held is the running balance (collected - paid out -
     * commission).
     */
    public record LedgerRow(LocalDate date, String kind, int monthNo, String party, String mode, BigDecimal moneyIn,
                            BigDecimal moneyOut, BigDecimal held, String entryNo, String note, Long paymentId) {
    }

    public record Detail(ChitView chit, List<MemberView> members, List<MonthView> schedule, List<PaymentView> payments,
                         List<LedgerRow> ledger, List<LateFeeView> lateFees, List<AgreementView> agreements) {
    }

    /** The dashboard line: dues still to collect across the running hosted chits. */
    public record Summary(int chits, int running, BigDecimal pendingDues, int pendingCount, BigDecimal held,
                          BigDecimal collectedThisMonth, BigDecimal expectedThisMonth, BigDecimal commissionEarned,
                          LocalDate nextDueDate) {
    }

    private final HostedChitRepository chits;
    private final HostedChitMemberRepository members;
    private final HostedChitMonthRepository months;
    private final HostedChitPaymentRepository payments;
    private final HostedChitShareRepository shares;
    private final HostedChitAgreementRepository agreements;
    private final AttachmentRepository attachments;
    private final AccountRepository accounts;
    private final CategoryRepository categoryRepository;
    private final JournalEntryRepository entries;
    private final AccountService accountService;
    private final CategoryService categoryService;
    private final LedgerService ledger;
    private final ActivityService activity;
    private final JournalLineRepository lines;

    public HostedChitService(HostedChitRepository chits, HostedChitMemberRepository members, HostedChitMonthRepository months,
                             HostedChitPaymentRepository payments, HostedChitShareRepository shares,
                             HostedChitAgreementRepository agreements, AttachmentRepository attachments,
                             AccountRepository accounts, CategoryRepository categoryRepository,
                             JournalEntryRepository entries, AccountService accountService, CategoryService categoryService,
                             LedgerService ledger, ActivityService activity, JournalLineRepository lines) {
        this.lines = lines;
        this.chits = chits;
        this.members = members;
        this.months = months;
        this.payments = payments;
        this.shares = shares;
        this.agreements = agreements;
        this.attachments = attachments;
        this.accounts = accounts;
        this.categoryRepository = categoryRepository;
        this.entries = entries;
        this.accountService = accountService;
        this.categoryService = categoryService;
        this.ledger = ledger;
        this.activity = activity;
    }

    // ================================================================== queries

    public List<ChitView> list() {
        return chits.findByTenantId(UserContext.tenantId()).stream()
                .sorted(Comparator.comparing((HostedChit c) -> HostedChit.COMPLETED.equals(c.getStatus()))
                        .thenComparing(HostedChit::getStartMonth, Comparator.reverseOrder()))
                .map(c -> new Calc(c).view())
                .toList();
    }

    public Detail detail(Long id) {
        return new Calc(require(id)).detail();
    }

    public Summary summary() {
        List<ChitView> all = list();
        List<ChitView> running = all.stream().filter(c -> HostedChit.ACTIVE.equals(c.status())).toList();
        Function<Function<ChitView, BigDecimal>, BigDecimal> sum = f -> running.stream().map(f).reduce(Money.ZERO, BigDecimal::add);
        return new Summary(all.size(), running.size(), sum.apply(ChitView::pendingDues),
                running.stream().mapToInt(ChitView::pendingCount).sum(), sum.apply(ChitView::held),
                sum.apply(ChitView::collectedThisMonth), sum.apply(ChitView::expectedThisMonth),
                all.stream().map(ChitView::commissionEarned).reduce(Money.ZERO, BigDecimal::add),
                running.stream().map(ChitView::nextDueDate).filter(Objects::nonNull).min(Comparator.naturalOrder()).orElse(null));
    }

    // ================================================================== create / update / delete

    @Transactional
    public Detail create(ChitRequest r) {
        if (!Objects.equals(r.memberCount(), r.months())) {
            throw new BusinessException("Members (" + r.memberCount() + ") must equal the months (" + r.months()
                    + "): each member wins exactly once");
        }
        List<MemberInput> list = cleanMembers(r.members() == null ? List.of() : r.members());
        if (list.size() != r.memberCount()) {
            throw new BusinessException("Add all " + r.memberCount() + " members (" + list.size() + " added)");
        }
        HostedChit c = new HostedChit();
        c.setTenantId(UserContext.tenantId());
        c.setStatus(HostedChit.ACTIVE);
        c.setDemo(false);
        c.setCreatedBy(UserContext.username());
        c.setCreatedAt(LocalDateTime.now());
        c.setStartMonth(r.startMonth().withDayOfMonth(1));
        c.setMemberCount(r.memberCount());
        c.setMonths(r.months());
        c.setChitType(HostedChit.TYPE_AUCTION.equalsIgnoreCase(r.chitType()) ? HostedChit.TYPE_AUCTION : HostedChit.TYPE_FIXED);
        c.setPostToBooks(true);   // a new chit is always recorded in the accounts
        apply(c, r);
        c = chits.save(c);
        addMembersAndMonths(c, list);
        activity.record("ADDED", AREA, "Started a hosted chit · " + c.getName() + " · " + (auction(c) ? "auction · " : "")
                + ActivityService.money(c.getBaseValue()) + " · " + c.getMemberCount() + " members");
        return detail(c.getId());
    }

    @Transactional
    public Detail update(Long id, ChitRequest r) {
        HostedChit c = require(id);
        if (r.version() != null && !Objects.equals(r.version(), c.getVersion())) {
            throw new ConcurrentUpdateException("hosted_chits", id);
        }
        boolean locked = structureLocked(c);
        LocalDate start = r.startMonth().withDayOfMonth(1);
        if (locked && (!start.equals(c.getStartMonth()) || !r.memberCount().equals(c.getMemberCount()) || !r.months().equals(c.getMonths()))) {
            throw new BusinessException("The start month, members and months cannot change once collections or winners are recorded");
        }
        if (!locked && (!r.memberCount().equals(c.getMemberCount()) || !r.months().equals(c.getMonths()))) {
            throw new BusinessException("To change the number of members or months, delete this chit and host it again");
        }
        c.setStartMonth(start);
        apply(c, r);
        chits.save(c);
        activity.record("CHANGED", AREA, "Edited a hosted chit · " + c.getName()
                + (Boolean.TRUE.equals(c.getPostToBooks()) ? " · posts to the books" : " · tracked here only"));
        return detail(id);
    }

    /**
     * Deletes a chit. Accepted or signed agreements are legal records: a chit with any cannot be deleted. When money
     * is recorded (payments or payouts), the chit is only deleted with {@code revert} and its name typed as
     * {@code confirm}: every payment and payout is undone and its journal entries are taken out of the books first.
     */
    @Transactional
    public void delete(Long id, boolean revert, String confirm) {
        HostedChit c = require(id);
        String name = c.getName();
        long signed = agreements.findByChitId(id).stream().filter(a -> !HostedChitAgreement.DRAFT.equals(a.getStatus())).count();
        if (signed > 0) {
            throw new BusinessException(name + " has " + signed + " accepted agreement" + (signed == 1 ? "" : "s")
                    + ", kept as a legal record, so it cannot be deleted");
        }
        List<HostedChitPayment> paid = payments.findByChitId(id);
        long payouts = months.findByChitId(id).stream().filter(m -> m.getPayoutDate() != null).count();
        long entries = paid.stream().filter(p -> p.getJournalEntryId() != null).count()
                + months.findByChitId(id).stream().mapToLong(m -> (m.getPayoutEntryId() != null ? 1 : 0) + (m.getCommissionEntryId() != null ? 1 : 0)
                        + (m.getCommissionTransferEntryId() != null ? 1 : 0)).sum();
        boolean recorded = !paid.isEmpty() || payouts > 0;
        if (recorded && !revert) {
            throw new BusinessException(name + " has " + paid.size() + " payment" + (paid.size() == 1 ? "" : "s") + " and " + payouts
                    + " payout" + (payouts == 1 ? "" : "s") + " recorded. Revert them before deleting the chit.");
        }
        if (recorded && (confirm == null || !confirm.trim().equalsIgnoreCase(name.trim()))) {
            throw new BusinessException("Type the chit's name, " + name + ", to confirm");
        }
        removeChit(c);
        activity.record("DELETED", AREA, "Deleted a hosted chit · " + name + (recorded ? " · reverted " + paid.size() + " payment(s), "
                + payouts + " payout(s) and " + entries + " journal entr" + (entries == 1 ? "y" : "ies") : ""));
    }

    private void apply(HostedChit c, ChitRequest r) {
        c.setName(r.name().trim());
        c.setDueDay(r.dueDay() == null ? 5 : r.dueDay());
        c.setBaseValue(Money.round(r.baseValue()));
        c.setCommission(Money.round(r.commission()));
        if (auction(c)) {
            // the chit value is fixed and shared equally: installment = chit value / members
            c.setInstallment(Money.round(c.getBaseValue().divide(BigDecimal.valueOf(c.getMemberCount()), 2, java.math.RoundingMode.HALF_UP)));
            c.setMonthlyIncrement(Money.ZERO);
            BigDecimal max = r.maxBidPercent() == null ? BigDecimal.valueOf(40) : r.maxBidPercent();
            if (max.signum() <= 0 || max.compareTo(BigDecimal.valueOf(40)) > 0) {
                throw new BusinessException("The highest bid must be between 1% and 40% of the chit value");
            }
            c.setMaxBidPercent(max);
            if (c.getCommission().compareTo(maxBid(c)) >= 0) {
                throw new BusinessException("The commission must be less than the highest bid (" + ActivityService.money(maxBid(c)) + ")");
            }
        } else {
            if (r.installment() == null || r.installment().signum() <= 0) {
                throw new BusinessException("Enter how much each member pays a month");
            }
            c.setInstallment(Money.round(r.installment()));
            c.setMonthlyIncrement(Money.round(r.monthlyIncrement()));
            c.setMaxBidPercent(null);
        }
        BigDecimal lastValue = c.getBaseValue().add(c.getMonthlyIncrement().multiply(BigDecimal.valueOf(c.getMonths() - 1L)));
        if (c.getCommission().compareTo(c.getBaseValue()) >= 0) {
            throw new BusinessException("The commission must be less than the chit value (" + ActivityService.money(c.getBaseValue()) + ")");
        }
        if (lastValue.signum() <= 0) {
            throw new BusinessException("The chit value must stay above zero");
        }
        String extraType = auction(c) || r.winnerExtraType() == null || r.winnerExtraType().isBlank() ? EXTRA_NONE
                : r.winnerExtraType().trim().toUpperCase();
        if (!Set.of(EXTRA_NONE, EXTRA_PERCENT, EXTRA_FIXED).contains(extraType)) {
            throw new BusinessException("Winner extra must be none, a percent or a fixed amount");
        }
        BigDecimal extraValue = EXTRA_NONE.equals(extraType) ? Money.ZERO : Money.nz(r.winnerExtraValue());
        if (!EXTRA_NONE.equals(extraType) && extraValue.signum() <= 0) {
            throw new BusinessException("Enter how much extra winners pay");
        }
        if (EXTRA_PERCENT.equals(extraType) && extraValue.compareTo(Money.HUNDRED) > 0) {
            throw new BusinessException("The winner extra can be at most 100% of the chit value");
        }
        c.setWinnerExtraType(extraType);
        c.setWinnerExtraValue(extraValue);
        c.setNotes(blank(r.notes()));
        BigDecimal late = Money.nz(r.lateFeePercent());
        if (late.compareTo(BigDecimal.TEN) > 0) {
            throw new BusinessException("Late payment interest can be at most 10% a month");
        }
        c.setLateFeePercent(late.signum() > 0 ? late : null);
        c.setLateGraceDays(r.lateGraceDays() == null ? 0 : r.lateGraceDays());
        String upi = blank(r.upiId());
        if (upi != null && !upi.matches("[\\w.\\-]{2,}@[A-Za-z][\\w.]{1,}")) {
            throw new BusinessException("The UPI ID should look like name@bank");
        }
        c.setUpiId(upi);
        c.setPayeeName(blank(r.payeeName()));
        // once recorded in the accounts, always: turning it off would leave half the chit in the books
        c.setPostToBooks(Boolean.TRUE.equals(c.getPostToBooks()) || Boolean.TRUE.equals(r.postToBooks()));
        if (c.getPostToBooks()) {
            Account account = Boolean.TRUE.equals(r.separateCollectionAccount())
                    ? accountService.createInternal(ActivityService.cut(c.getName() + " - collections", 100), AccountType.CASH,
                        "Members' installments for the chit " + c.getName() + " (Host a Chit)", false)
                    : r.accountId() != null ? accountService.require(r.accountId())
                    : accountService.systemAccount(DefaultChartOfAccounts.CASH);
            requireCashLike(account, "Collect into a cash, bank or wallet account");
            c.setAccountId(account.getId());
            Account commission = Boolean.TRUE.equals(r.separateCommissionAccount())
                    ? accountService.createInternal(ActivityService.cut(c.getName() + " - commission", 100), AccountType.CASH,
                        "My commission from the chit " + c.getName() + " (Host a Chit)", false)
                    : r.commissionAccountId() != null ? accountService.require(r.commissionAccountId()) : null;
            if (commission != null) {
                requireCashLike(commission, "Keep the commission in a cash, bank or wallet account");
            }
            c.setCommissionAccountId(commission == null || commission.getId().equals(account.getId()) ? null : commission.getId());
            Account lateAccount = Boolean.TRUE.equals(r.separateLateFeeAccount())
                    ? accountService.createInternal(ActivityService.cut(c.getName() + " - late interest", 100), AccountType.CASH,
                        "Late payment interest from the chit " + c.getName() + " (Host a Chit)", false)
                    : r.lateFeeAccountId() != null ? accountService.require(r.lateFeeAccountId()) : null;
            if (lateAccount != null) {
                requireCashLike(lateAccount, "Keep late interest in a cash, bank or wallet account");
            }
            c.setLateFeeAccountId(lateAccount == null ? null : lateAccount.getId());
            c.setCommissionCategoryId(r.commissionCategoryId() != null
                    ? categoryService.require(r.commissionCategoryId(), CategoryKind.INCOME).getId()
                    : commissionCategory(c).getId());
        } else {
            c.setAccountId(r.accountId());
            c.setCommissionAccountId(r.commissionAccountId());
            c.setCommissionCategoryId(r.commissionCategoryId());
            c.setLateFeeAccountId(r.lateFeeAccountId());
        }
    }

    private static void requireCashLike(Account a, String message) {
        if (a.getAccountClass() != AccountClass.ASSET || a.getAccountType() == AccountType.CHIT_FUND) {
            throw new BusinessException(message);
        }
    }

    private void addMembersAndMonths(HostedChit c, List<MemberInput> list) {
        List<HostedChitMember> rows = new ArrayList<>();
        for (int i = 0; i < list.size(); i++) {
            HostedChitMember m = new HostedChitMember();
            m.setTenantId(c.getTenantId());
            m.setChitId(c.getId());
            m.setSlot(i + 1);
            m.setName(ActivityService.cut(list.get(i).name().trim(), 100));
            m.setPhone(blank(list.get(i).phone()));
            m.setEmail(blank(list.get(i).email()));
            rows.add(m);
        }
        members.saveAll(rows);
        List<HostedChitMonth> schedule = new ArrayList<>();
        for (int no = 1; no <= c.getMonths(); no++) {
            HostedChitMonth m = new HostedChitMonth();
            m.setTenantId(c.getTenantId());
            m.setChitId(c.getId());
            m.setMonthNo(no);
            schedule.add(m);
        }
        months.saveAll(schedule);
    }

    /** Removes a chit with everything under it, and the journal entries it posted. */
    private void removeChit(HostedChit c) {
        List<Long> journal = new ArrayList<>();
        for (HostedChitPayment p : payments.findByChitId(c.getId())) {
            if (p.getJournalEntryId() != null) journal.add(p.getJournalEntryId());
        }
        for (HostedChitMonth m : months.findByChitId(c.getId())) {
            if (m.getPayoutEntryId() != null) journal.add(m.getPayoutEntryId());
            if (m.getCommissionEntryId() != null) journal.add(m.getCommissionEntryId());
            if (m.getCommissionTransferEntryId() != null) journal.add(m.getCommissionTransferEntryId());
        }
        shares.deleteAll(shares.findByChitId(c.getId()));
        agreements.deleteAll(agreements.findByChitId(c.getId()));
        payments.deleteAll(payments.findByChitId(c.getId()));
        months.deleteAll(months.findByChitId(c.getId()));
        members.deleteAll(members.findByChitId(c.getId()));
        chits.deleteById(c.getId());
        journal.forEach(ledger::delete);
    }

    @Transactional
    public Detail updateMember(Long chitId, Long memberId, MemberInput r) {
        HostedChit c = require(chitId);
        HostedChitMember m = requireMember(c, memberId);
        String before = m.getName();
        String name = r.name().trim().replaceAll("\\s+", " ");
        if (members.findByChitId(chitId).stream().anyMatch(x -> !x.getId().equals(memberId) && x.getName().equalsIgnoreCase(name))) {
            throw new BusinessException("Another member is already called " + name);
        }
        m.setName(ActivityService.cut(name, 100));
        m.setPhone(cleanPhone(r.phone(), name));
        m.setEmail(blank(r.email()));
        members.save(m);
        activity.record("CHANGED", AREA, "Edited a member · " + c.getName() + " · " + before
                + (before.equals(m.getName()) ? "" : " → " + m.getName()));
        return detail(chitId);
    }

    @Transactional
    public Detail setReceiptSignature(Long chitId, SignatureRequest r) {
        HostedChit c = require(chitId);
        String signature = r.signature() == null ? "" : r.signature().trim();
        if (!signature.isEmpty() && (signature.length() < 20 || !signature.matches("[MLml0-9 .\\-]+"))) {
            throw new BusinessException("Draw your signature in the box");
        }
        c.setReceiptSignature(signature.isEmpty() ? null : signature);
        c.setReceiptSigner(signature.isEmpty() ? null : blank(r.signer()));
        chits.save(c);
        activity.record("CHANGED", AREA, (signature.isEmpty() ? "Removed the receipt signature · " : "Set the receipt signature · ") + c.getName());
        return detail(chitId);
    }

    // ================================================================== collections

    @Transactional
    public Detail addPayment(Long chitId, PaymentRequest r) {
        HostedChit c = require(chitId);
        HostedChitMember member = requireMember(c, r.memberId());
        requireMonthNo(c, r.monthNo());
        BigDecimal amount = Money.round(r.amount());
        Calc calc = new Calc(c);
        requireAuctionDone(c, calc, r.monthNo());
        checkPaidDate(c, r.paidDate());
        checkExcess(calc, member, r.monthNo(), amount, null, r.allowExcess());
        BigDecimal lateFee = Money.round(Money.nz(r.lateFee()));
        BigDecimal waived = Money.round(Money.nz(r.lateFeeWaived()));
        checkLateFee(calc, member, r.monthNo(), lateFee.add(waived), null, r.allowExcess());
        if (amount.add(lateFee).add(waived).signum() <= 0) {
            throw new BusinessException("Enter the amount received");
        }

        HostedChitPayment p = new HostedChitPayment();
        p.setTenantId(c.getTenantId());
        p.setChitId(c.getId());
        p.setMemberId(member.getId());
        p.setMonthNo(r.monthNo());
        p.setAmount(amount);
        p.setLateFee(lateFee.signum() > 0 ? lateFee : null);
        p.setLateFeeWaived(waived.signum() > 0 ? waived : null);
        p.setReference(blank(r.reference()));
        p.setPaidDate(r.paidDate() != null ? r.paidDate() : LocalDate.now());
        p.setMode(mode(r.mode()));
        p.setNote(blank(r.note()));
        p.setCreatedBy(UserContext.username());
        p.setCreatedAt(LocalDateTime.now());
        p = payments.save(p);
        p.setReceiptNo(String.format("RC-%06d", p.getId()));
        if (Boolean.TRUE.equals(c.getPostToBooks()) && amount.add(lateFee).signum() > 0) {
            p.setJournalEntryId(ledger.post(collectionDraft(c, member, p)).getId());
        }
        payments.save(p);
        activity.record("POSTED", AREA, "Collected · " + member.getName() + " · " + c.getName() + " month " + p.getMonthNo()
                + " · " + ActivityService.money(amount) + (lateFee.signum() > 0 ? " + late interest " + ActivityService.money(lateFee) : "")
                + " · " + p.getMode() + " · " + p.getReceiptNo());
        return detail(chitId);
    }

    @Transactional
    public Detail updatePayment(Long chitId, Long paymentId, PaymentRequest r) {
        HostedChit c = require(chitId);
        HostedChitPayment p = requirePayment(c, paymentId);
        if (r.version() != null && !Objects.equals(r.version(), p.getVersion())) {
            throw new ConcurrentUpdateException("hosted_chit_payments", paymentId);
        }
        HostedChitMember member = requireMember(c, p.getMemberId());
        BigDecimal amount = Money.round(r.amount());
        Calc calc = new Calc(c);
        checkPaidDate(c, r.paidDate());
        checkExcess(calc, member, p.getMonthNo(), amount, p.getId(), r.allowExcess());
        BigDecimal lateFee = Money.round(Money.nz(r.lateFee()));
        BigDecimal waived = Money.round(Money.nz(r.lateFeeWaived()));
        checkLateFee(calc, member, p.getMonthNo(), lateFee.add(waived), p.getId(), r.allowExcess());
        if (amount.add(lateFee).add(waived).signum() <= 0) {
            throw new BusinessException("Enter the amount received");
        }
        BigDecimal before = p.getAmount();
        p.setAmount(amount);
        p.setLateFee(lateFee.signum() > 0 ? lateFee : null);
        p.setLateFeeWaived(waived.signum() > 0 ? waived : null);
        p.setReference(blank(r.reference()));
        if (r.paidDate() != null) p.setPaidDate(r.paidDate());
        p.setMode(mode(r.mode()));
        p.setNote(blank(r.note()));
        boolean post = amount.add(lateFee).signum() > 0;
        if (p.getJournalEntryId() != null && post) {
            ledger.repost(p.getJournalEntryId(), collectionDraft(c, member, p));
        } else if (p.getJournalEntryId() != null) {
            Long entryId = p.getJournalEntryId();
            p.setJournalEntryId(null);
            payments.save(p);
            ledger.delete(entryId);
        } else if (Boolean.TRUE.equals(c.getPostToBooks()) && post) {
            p.setJournalEntryId(ledger.post(collectionDraft(c, member, p)).getId());
        }
        if (p.getReceiptNo() == null) p.setReceiptNo(String.format("RC-%06d", p.getId()));
        payments.save(p);
        activity.record("CHANGED", AREA, "Edited a collection · " + member.getName() + " · " + c.getName() + " month "
                + p.getMonthNo() + " · " + ActivityService.money(before) + " → " + ActivityService.money(amount));
        return detail(chitId);
    }

    @Transactional
    public Detail deletePayment(Long chitId, Long paymentId) {
        HostedChit c = require(chitId);
        HostedChitPayment p = requirePayment(c, paymentId);
        HostedChitMember member = requireMember(c, p.getMemberId());
        Long entryId = p.getJournalEntryId();
        shares.deleteAll(shares.findByChitId(c.getId()).stream().filter(x -> p.getId().equals(x.getPaymentId())).toList());
        payments.deleteById(p.getId());
        if (entryId != null) {
            ledger.delete(entryId);
        }
        activity.record("DELETED", AREA, "Undid a collection · " + member.getName() + " · " + c.getName() + " month "
                + p.getMonthNo() + " · " + ActivityService.money(p.getAmount()));
        return detail(chitId);
    }

    /** Records whatever each member still owes for the month, in one go. */
    @Transactional
    public Detail collectAll(Long chitId, int monthNo, CollectAllRequest r) {
        HostedChit c = require(chitId);
        requireMonthNo(c, monthNo);
        Calc calc = new Calc(c);
        requireAuctionDone(c, calc, monthNo);
        LocalDate date = r != null && r.paidDate() != null ? r.paidDate() : LocalDate.now();
        checkPaidDate(c, date);
        String mode = mode(r == null ? null : r.mode());
        int count = 0;
        BigDecimal total = Money.ZERO;
        for (HostedChitMember m : calc.memberList) {
            BigDecimal rest = calc.due(m.getId(), monthNo).subtract(calc.paid(m.getId(), monthNo));
            if (rest.signum() <= 0) continue;
            HostedChitPayment p = new HostedChitPayment();
            p.setTenantId(c.getTenantId());
            p.setChitId(c.getId());
            p.setMemberId(m.getId());
            p.setMonthNo(monthNo);
            p.setAmount(rest);
            p.setPaidDate(date);
            p.setMode(mode);
            p.setNote("Marked paid for the month");
            p.setCreatedBy(UserContext.username());
            p.setCreatedAt(LocalDateTime.now());
            p = payments.save(p);
            if (Boolean.TRUE.equals(c.getPostToBooks())) {
                p.setJournalEntryId(ledger.post(collectionDraft(c, m, p)).getId());
                payments.save(p);
            }
            count++;
            total = total.add(rest);
        }
        if (count == 0) {
            throw new BusinessException("Everyone has already paid month " + monthNo);
        }
        activity.record("POSTED", AREA, "Marked all paid · " + c.getName() + " month " + monthNo + " · " + count
                + " member" + (count == 1 ? "" : "s") + " · " + ActivityService.money(total));
        return detail(chitId);
    }

    /**
     * Auction chits: what each member pays for a month is the installment less that month's dividend, known only once
     * the auction is recorded, so nothing is collected for a month before its auction.
     */
    private static void requireAuctionDone(HostedChit c, Calc calc, int monthNo) {
        if (!auction(c)) return;
        HostedChitMonth month = calc.month(monthNo);
        if (month.getBidAmount() == null) {
            throw new BusinessException("Record the auction for month " + monthNo + " first: what each member pays depends on the winning bid (the dividend)");
        }
    }

    /** A payment date cannot be in the future, nor before the chit starts. */
    private static void checkPaidDate(HostedChit c, LocalDate date) {
        if (date == null) return;
        if (date.isAfter(LocalDate.now())) {
            throw new BusinessException("The payment date cannot be in the future");
        }
        if (date.isBefore(c.getStartMonth().minusMonths(1))) {
            throw new BusinessException("The payment date is before the chit starts (" + c.getStartMonth() + ")");
        }
    }

    private void checkExcess(Calc calc, HostedChitMember m, int monthNo, BigDecimal amount, Long ignorePaymentId, Boolean allow) {
        BigDecimal already = calc.paymentList.stream()
                .filter(p -> p.getMemberId().equals(m.getId()) && p.getMonthNo() == monthNo && !p.getId().equals(ignorePaymentId))
                .map(HostedChitPayment::getAmount).reduce(Money.ZERO, BigDecimal::add);
        BigDecimal due = calc.due(m.getId(), monthNo);
        if (already.add(amount).compareTo(due) > 0 && !Boolean.TRUE.equals(allow)) {
            throw new BusinessException(m.getName() + " would pay " + ActivityService.money(already.add(amount)) + " for month "
                    + monthNo + ", more than the " + ActivityService.money(due) + " due. Confirm to record it anyway.");
        }
    }

    /**
     * The installment goes into the collection account and is owed to the members (Hosted Chit Funds); late interest
     * is the organiser's income (commission category), kept in the commission account when there is one.
     */
    private JournalDraft collectionDraft(HostedChit c, HostedChitMember m, HostedChitPayment p) {
        BigDecimal late = Money.nz(p.getLateFee());
        JournalDraft draft = JournalDraft.of(p.getPaidDate(), VoucherType.HOSTED_CHIT_COLLECTION,
                        "Chit collection - " + m.getName() + " - " + c.getName() + " month " + p.getMonthNo() + "/" + c.getMonths()
                                + (late.signum() > 0 ? " (with late interest)" : ""))
                .debit(c.getAccountId(), p.getAmount(), p.getMode())
                .credit(fundsAccount().getId(), p.getAmount());
        if (late.signum() > 0) {
            Long into = c.getLateFeeAccountId() != null ? c.getLateFeeAccountId()
                    : c.getCommissionAccountId() != null ? c.getCommissionAccountId() : c.getAccountId();
            draft.debit(into, late, "Late payment interest")
                    .credit(accountService.systemAccount(DefaultChartOfAccounts.INCOME).getId(), late, "Late payment interest")
                    .category(lateFeeCategory().getId());
        }
        return draft.party(m.getName())
                .reference(p.getReference() == null ? p.getReceiptNo() : ActivityService.cut(p.getReference(), 60))
                .source(SOURCE_COLLECTION, p.getId());
    }

    /**
     * The commission earned: two lines only (Hosted Chit Funds → income), so the journal shows the amount once. When
     * the commission has its own account, moving the money there is a separate transfer ({@link #commissionTransferDraft}).
     */
    private JournalDraft commissionDraft(HostedChit c, HostedChitMonth month, LocalDate date, BigDecimal commission) {
        Long categoryId = c.getCommissionCategoryId() != null ? c.getCommissionCategoryId() : commissionCategory(c).getId();
        return JournalDraft.of(date, VoucherType.INCOME, "Chit commission - " + c.getName() + " month " + month.getMonthNo())
                .debit(fundsAccount().getId(), commission)
                .credit(accountService.systemAccount(DefaultChartOfAccounts.INCOME).getId(), commission, "Organiser commission")
                .category(categoryId)
                .party(c.getName())
                .source(SOURCE_COMMISSION, month.getId());
    }

    private JournalDraft commissionTransferDraft(HostedChit c, HostedChitMonth month, LocalDate date, BigDecimal commission) {
        return JournalDraft.of(date, VoucherType.TRANSFER, "Chit commission to its account - " + c.getName() + " month " + month.getMonthNo())
                .debit(c.getCommissionAccountId(), commission, "Commission kept")
                .credit(c.getAccountId(), commission)
                .party(c.getName())
                .source(SOURCE_COMMISSION, month.getId());
    }

    private static boolean separateCommission(HostedChit c) {
        return c.getCommissionAccountId() != null && !c.getCommissionAccountId().equals(c.getAccountId());
    }

    /**
     * Commission entries posted before the split had four lines (income and the move to the commission account in one
     * voucher), so the journal showed the amount twice. Rewrites each as the income entry plus a separate transfer.
     * Runs for the tenant in context; returns how many were repaired.
     */
    @Transactional
    public int repairCommissionEntries() {
        Long tenantId = UserContext.tenantId();
        int repaired = 0;
        for (HostedChitMonth month : months.findByTenantId(tenantId)) {
            if (month.getCommissionEntryId() == null || month.getCommissionTransferEntryId() != null) continue;
            if (lines.findByJournalEntryId(month.getCommissionEntryId()).size() <= 2) continue;
            HostedChit c = chits.findById(month.getChitId()).orElse(null);
            if (c == null || !separateCommission(c) || month.getCommissionAmount() == null) continue;
            BigDecimal commission = month.getCommissionAmount();
            LocalDate date = month.getPayoutDate() != null ? month.getPayoutDate() : LocalDate.now();
            ledger.repost(month.getCommissionEntryId(), commissionDraft(c, month, date, commission));
            month.setCommissionTransferEntryId(ledger.post(commissionTransferDraft(c, month, date, commission)).getId());
            months.save(month);
            repaired++;
        }
        return repaired;
    }

    /** Late interest settled (collected or let off) must not exceed what has accrued, unless confirmed. */
    private static void checkLateFee(Calc calc, HostedChitMember m, int monthNo, BigDecimal settling, Long ignorePaymentId, Boolean allow) {
        if (settling.signum() <= 0) return;
        BigDecimal open = calc.lateAccrued(m.getId(), monthNo).subtract(calc.lateSettled(m.getId(), monthNo, ignorePaymentId)).max(Money.ZERO);
        if (settling.compareTo(open) > 0 && !Boolean.TRUE.equals(allow)) {
            throw new BusinessException("Only " + ActivityService.money(open) + " of late interest is due from " + m.getName()
                    + " for month " + monthNo + ". Confirm to record it anyway.");
        }
    }

    // ================================================================== winner and payout

    @Transactional
    public Detail setWinner(Long chitId, int monthNo, WinnerRequest r) {
        HostedChit c = require(chitId);
        Calc calc = new Calc(c);
        HostedChitMonth month = calc.month(monthNo);
        if (month.getPayoutDate() != null) {
            throw new BusinessException("Month " + monthNo + " is paid out and locked");
        }
        if (monthNo != calc.currentMonth) {
            throw new BusinessException("Pick the winner of month " + calc.currentMonth + " first (months close in order)");
        }
        HostedChitMember member = requireMember(c, r.memberId());
        Integer won = calc.wonMonth(member.getId());
        if (won != null && won != monthNo) {
            throw new BusinessException(member.getName() + " already won month " + won + "; a member wins only once");
        }
        if (auction(c) && month.getBidAmount() != null && hasPayments(calc, monthNo)) {
            throw new BusinessException("Payments for month " + monthNo + " were collected with the dividend of this auction; undo them before changing the auction");
        }
        month.setWinnerMemberId(member.getId());
        if (auction(c)) {
            long left = calc.memberList.stream().filter(m -> calc.wonMonth(m.getId()) == null || calc.wonMonth(m.getId()) == monthNo).count();
            // the last member left has no one to bid against: they take the chit at the lowest bid
            BigDecimal bid = left <= 1 || r.bid() == null ? c.getCommission() : Money.round(r.bid());
            if (bid.compareTo(c.getCommission()) < 0 || bid.compareTo(maxBid(c)) > 0) {
                throw new BusinessException("The winning bid must be between " + ActivityService.money(c.getCommission())
                        + " (the commission) and " + ActivityService.money(maxBid(c)) + " (" + c.getMaxBidPercent().stripTrailingZeros().toPlainString()
                        + "% of the chit value)");
            }
            month.setBidAmount(bid);
            month.setDrawMethod("Auction");
        } else {
            month.setBidAmount(null);
            month.setDrawMethod(Boolean.TRUE.equals(r.random()) ? "Random draw" : "Picked");
        }
        months.save(month);
        activity.record("CHANGED", AREA, (auction(c) ? "Recorded the auction · " : "Chose the winner · ") + c.getName() + " month "
                + monthNo + " · " + member.getName() + " · "
                + (auction(c) ? "bid " + ActivityService.money(month.getBidAmount()) : month.getDrawMethod().toLowerCase()));
        return detail(chitId);
    }

    @Transactional
    public Detail clearWinner(Long chitId, int monthNo) {
        HostedChit c = require(chitId);
        Calc calc = new Calc(c);
        HostedChitMonth month = calc.month(monthNo);
        if (month.getPayoutDate() != null) {
            throw new BusinessException("Month " + monthNo + " is paid out and locked; undo the payout first");
        }
        if (auction(c) && hasPayments(calc, monthNo)) {
            throw new BusinessException("Payments for month " + monthNo + " were collected with this auction's dividend; undo them before removing the auction");
        }
        month.setWinnerMemberId(null);
        month.setDrawMethod(null);
        month.setBidAmount(null);
        months.save(month);
        activity.record("CHANGED", AREA, "Cleared the winner · " + c.getName() + " month " + monthNo);
        return detail(chitId);
    }

    @Transactional
    public Detail payout(Long chitId, int monthNo, PayoutRequest r) {
        HostedChit c = require(chitId);
        Calc calc = new Calc(c);
        HostedChitMonth month = calc.month(monthNo);
        if (month.getPayoutDate() != null) {
            throw new BusinessException("Month " + monthNo + " is already paid out");
        }
        if (monthNo != calc.currentMonth) {
            throw new BusinessException("Close month " + calc.currentMonth + " first (months close in order)");
        }
        if (month.getWinnerMemberId() == null) {
            throw new BusinessException("Choose the winner of month " + monthNo + " first");
        }
        BigDecimal dues = Money.ZERO;
        int unpaid = 0;
        for (HostedChitMember m : calc.memberList) {
            BigDecimal rest = calc.due(m.getId(), monthNo).subtract(calc.paid(m.getId(), monthNo));
            if (rest.signum() > 0) {
                dues = dues.add(rest);
                unpaid++;
            }
        }
        if (unpaid > 0 && !Boolean.TRUE.equals(r.allowDues())) {
            throw new BusinessException(unpaid + " member" + (unpaid == 1 ? " has" : "s have") + " not paid month " + monthNo
                    + " in full (" + ActivityService.money(dues) + " due). Confirm to close the month anyway.");
        }
        HostedChitMember winner = requireMember(c, month.getWinnerMemberId());
        if (r.payoutDate() != null && r.payoutDate().isAfter(LocalDate.now())) {
            throw new BusinessException("The payout date cannot be in the future");
        }
        if (r.payoutDate() != null && r.payoutDate().isBefore(c.getStartMonth())) {
            throw new BusinessException("The payout date is before the chit starts (" + c.getStartMonth() + ")");
        }
        BigDecimal value = calc.chitValue(monthNo);
        BigDecimal commission = c.getCommission().min(value);
        BigDecimal payout = auction(c) ? value.subtract(Money.nz(month.getBidAmount())) : value.subtract(commission);
        LocalDate date = r.payoutDate() != null ? r.payoutDate() : LocalDate.now();
        month.setPayoutAmount(payout);
        month.setCommissionAmount(commission);
        month.setPayoutDate(date);
        month.setPayoutMode(mode(r.mode()));
        month.setPayoutReference(blank(r.reference()));
        if (Boolean.TRUE.equals(c.getPostToBooks())) {
            Long funds = fundsAccount().getId();
            String of = " (" + c.getName() + " month " + monthNo + "/" + c.getMonths() + ")";
            JournalEntry paid = ledger.post(JournalDraft.of(date, VoucherType.HOSTED_CHIT_PAYOUT, "Chit payout - " + winner.getName() + of)
                    .debit(funds, payout)
                    .credit(c.getAccountId(), payout, month.getPayoutMode())
                    .party(winner.getName())
                    .source(SOURCE_PAYOUT, month.getId()));
            month.setPayoutEntryId(paid.getId());
            if (commission.signum() > 0) {
                month.setCommissionEntryId(ledger.post(commissionDraft(c, month, date, commission)).getId());
                if (separateCommission(c)) {
                    month.setCommissionTransferEntryId(ledger.post(commissionTransferDraft(c, month, date, commission)).getId());
                }
            }
        }
        months.save(month);
        if (calc.completedMonths + 1 >= c.getMonths()) {
            c.setStatus(HostedChit.COMPLETED);
            chits.save(c);
        }
        if (Boolean.TRUE.equals(r.createAgreement())) {
            makeAgreement(c, month, winner, r.guarantorName(), r.guarantorPhone(), null);
        }
        activity.record("POSTED", AREA, "Paid out · " + winner.getName() + " · " + c.getName() + " month " + monthNo + " · "
                + ActivityService.money(payout) + " · commission " + ActivityService.money(commission)
                + (unpaid > 0 ? " · closed with " + ActivityService.money(dues) + " due" : ""));
        return detail(chitId);
    }

    /** Undoes the payout of the last closed month (and the journal entries it posted). */
    @Transactional
    public Detail undoPayout(Long chitId, int monthNo) {
        HostedChit c = require(chitId);
        Calc calc = new Calc(c);
        HostedChitMonth month = calc.month(monthNo);
        if (month.getPayoutDate() == null) {
            throw new BusinessException("Month " + monthNo + " is not paid out");
        }
        if (monthNo != calc.completedMonths) {
            throw new BusinessException("Undo month " + calc.completedMonths + " first (the latest payout)");
        }
        HostedChitAgreement signed = agreementOf(c, monthNo);
        if (signed != null && !HostedChitAgreement.DRAFT.equals(signed.getStatus())) {
            throw new BusinessException("The winner has accepted the agreement for this payout, so it cannot be undone");
        }
        if (signed != null) {
            dropAgreement(c, signed);
        }
        List<Long> journal = new ArrayList<>();
        if (month.getPayoutEntryId() != null) journal.add(month.getPayoutEntryId());
        if (month.getCommissionEntryId() != null) journal.add(month.getCommissionEntryId());
        if (month.getCommissionTransferEntryId() != null) journal.add(month.getCommissionTransferEntryId());
        month.setPayoutAmount(null);
        month.setCommissionAmount(null);
        month.setPayoutDate(null);
        month.setPayoutMode(null);
        month.setPayoutReference(null);
        month.setPayoutEntryId(null);
        month.setCommissionEntryId(null);
        month.setCommissionTransferEntryId(null);
        months.save(month);   // release the foreign keys before deleting the journal
        journal.forEach(ledger::delete);
        if (HostedChit.COMPLETED.equals(c.getStatus())) {
            c.setStatus(HostedChit.ACTIVE);
            chits.save(c);
        }
        activity.record("DELETED", AREA, "Undid a payout · " + c.getName() + " month " + monthNo);
        return detail(chitId);
    }

    // ================================================================== digital agreements

    /** Makes (or, while not yet accepted, remakes) the winner's agreement for a paid-out month. */
    @Transactional
    public Detail createAgreement(Long chitId, int monthNo, AgreementRequest r) {
        HostedChit c = require(chitId);
        HostedChitMonth month = new Calc(c).month(monthNo);
        if (month.getPayoutDate() == null || month.getWinnerMemberId() == null) {
            throw new BusinessException("Pay the winner of month " + monthNo + " first; the agreement records that payout");
        }
        makeAgreement(c, month, requireMember(c, month.getWinnerMemberId()), r.guarantorName(), r.guarantorPhone(), blank(r.terms()));
        return detail(chitId);
    }

    @Transactional
    public Detail deleteAgreement(Long chitId, Long agreementId) {
        HostedChit c = require(chitId);
        HostedChitAgreement a = requireAgreement(c, agreementId);
        if (!HostedChitAgreement.DRAFT.equals(a.getStatus())) {
            throw new BusinessException("An accepted or signed agreement is kept as a record and cannot be deleted");
        }
        dropAgreement(c, a);
        activity.record("DELETED", AREA, "Deleted the agreement " + a.getAgreementNo() + " · " + c.getName() + " month " + a.getMonthNo());
        return detail(chitId);
    }

    /** The member signed a paper copy: recorded by the organiser. */
    @Transactional
    public Detail markAgreementSigned(Long chitId, Long agreementId, String signedBy) {
        HostedChit c = require(chitId);
        HostedChitAgreement a = requireAgreement(c, agreementId);
        if (!HostedChitAgreement.DRAFT.equals(a.getStatus())) {
            throw new BusinessException("This agreement is already " + a.getStatus().toLowerCase());
        }
        a.setStatus(HostedChitAgreement.SIGNED);
        a.setAcceptedName(blank(signedBy) != null ? ActivityService.cut(signedBy.trim(), 100) : members.findById(a.getMemberId()).map(HostedChitMember::getName).orElse(null));
        a.setAcceptedAt(LocalDateTime.now());
        a.setAcceptedFrom("Signed in person, recorded by " + UserContext.get().fullName());
        agreements.save(a);
        activity.record("CHANGED", AREA, "Agreement signed in person · " + a.getAgreementNo() + " · " + c.getName() + " month " + a.getMonthNo());
        return detail(chitId);
    }

    private void makeAgreement(HostedChit c, HostedChitMonth month, HostedChitMember winner, String guarantorName, String guarantorPhone, String terms) {
        HostedChitAgreement a = agreementOf(c, month.getMonthNo());
        if (a != null && !HostedChitAgreement.DRAFT.equals(a.getStatus())) {
            throw new BusinessException("The agreement for month " + month.getMonthNo() + " is already " + a.getStatus().toLowerCase());
        }
        boolean fresh = a == null;
        if (fresh) {
            a = new HostedChitAgreement();
            a.setTenantId(c.getTenantId());
            a.setChitId(c.getId());
            a.setMonthNo(month.getMonthNo());
            a.setAgreementNo("AG-pending");
            a.setTerms("pending");          // filled in below, once the number is known
            a.setContentHash("pending");
            a.setCreatedBy(UserContext.username());
            a.setCreatedAt(LocalDateTime.now());
        }
        Calc calc = new Calc(c);
        int remaining = c.getMonths() - month.getMonthNo();
        BigDecimal remainingAmount = Money.ZERO;
        for (int no = month.getMonthNo() + 1; no <= c.getMonths(); no++) {
            // the extra a winner pays counts from the next month; auction months not yet held count in full
            remainingAmount = remainingAmount.add(auction(c) ? c.getInstallment() : c.getInstallment().add(winnerExtra(c)));
        }
        a.setMemberId(winner.getId());
        a.setChitValue(calc.chitValue(month.getMonthNo()));
        a.setDeduction(auction(c) ? month.getBidAmount() : month.getCommissionAmount());
        a.setPayoutAmount(Money.nz(month.getPayoutAmount()));
        a.setPayoutDate(month.getPayoutDate());
        a.setPayoutMode(month.getPayoutMode());
        a.setPayoutReference(month.getPayoutReference());
        a.setRemainingInstallments(remaining);
        a.setRemainingAmount(remainingAmount);
        a.setGuarantorName(blank(guarantorName));
        a.setGuarantorPhone(blank(guarantorPhone));
        a.setStatus(HostedChitAgreement.DRAFT);
        a = agreements.save(a);
        if (fresh) a.setAgreementNo(String.format("AG-%06d", a.getId()));
        a.setTerms(terms != null ? terms : agreementTerms(c, a, winner));
        a.setContentHash(sha256(a.getAgreementNo() + "|" + winner.getName() + "|" + a.getPayoutAmount().toPlainString() + "|" + a.getPayoutDate()
                + "|" + a.getRemainingInstallments() + "|" + a.getRemainingAmount().toPlainString() + "|" + a.getTerms()));
        agreements.save(a);
        activity.record(fresh ? "ADDED" : "CHANGED", AREA, (fresh ? "Made the agreement " : "Updated the agreement ") + a.getAgreementNo()
                + " · " + winner.getName() + " · " + c.getName() + " month " + month.getMonthNo() + " · " + ActivityService.money(a.getPayoutAmount()));
    }

    /** The standard wording, with the figures filled in. */
    private String agreementTerms(HostedChit c, HostedChitAgreement a, HostedChitMember winner) {
        String organiser = UserContext.get().fullName();
        String household = UserContext.get().tenantName();
        String rupees = ActivityService.money(a.getPayoutAmount());
        StringBuilder t = new StringBuilder();
        t.append("1. I, ").append(winner.getName()).append(", a member of the chit \"").append(c.getName()).append("\" (")
                .append(c.getMemberCount()).append(" members, chit value ").append(ActivityService.money(a.getChitValue()))
                .append(") run by ").append(organiser).append(" (").append(household).append("), confirm that I won month ")
                .append(a.getMonthNo()).append(" of ").append(c.getMonths()).append(auction(c) ? " in the auction with a bid of "
                        + ActivityService.money(a.getDeduction()) : "").append(".\n");
        t.append("2. I have received ").append(rupees).append(" (").append(inWords(a.getPayoutAmount())).append(")")
                .append(a.getPayoutDate() != null ? " on " + a.getPayoutDate().format(java.time.format.DateTimeFormatter.ofPattern("dd MMM yyyy")) : "")
                .append(a.getPayoutMode() != null ? " by " + a.getPayoutMode() : "")
                .append(a.getPayoutReference() != null ? " (reference " + a.getPayoutReference() + ")" : "")
                .append(" as my prize amount in full, being the chit value less ")
                .append(auction(c) ? "my winning bid" : "the organiser's commission").append(".\n");
        if (a.getRemainingInstallments() > 0) {
            t.append("3. I agree to keep paying my monthly installment for the remaining ").append(a.getRemainingInstallments())
                    .append(" month(s), up to the end of the chit, by the ").append(ordinal(c.getDueDay())).append(" of every month: ")
                    .append(auction(c) ? ActivityService.money(c.getInstallment()) + " less that month's dividend"
                            : ActivityService.money(c.getInstallment().add(winnerExtra(c))) + (winnerExtra(c).signum() > 0
                                ? " (" + ActivityService.money(c.getInstallment()) + " plus " + ActivityService.money(winnerExtra(c)) + " as a past winner)" : ""))
                    .append(", about ").append(ActivityService.money(a.getRemainingAmount())).append(" in all.\n");
        } else {
            t.append("3. This was the last month of the chit; no further installments are due from me after any dues already pending.\n");
        }
        t.append("4. ").append(c.getLateFeePercent() != null
                ? "A late installment carries interest of " + c.getLateFeePercent().stripTrailingZeros().toPlainString() + "% a month on the unpaid amount"
                    + (Money.nz(BigDecimal.valueOf(c.getLateGraceDays() == null ? 0 : c.getLateGraceDays())).signum() > 0 ? " after " + c.getLateGraceDays() + " days of grace" : "") + ". "
                : "")
                .append("If I do not pay, the organiser may recover the amount still owed by me from me")
                .append(a.getGuarantorName() != null ? " or from my guarantor, " + a.getGuarantorName() + (a.getGuarantorPhone() != null ? " (" + a.getGuarantorPhone() + ")" : "") : "")
                .append(".\n");
        t.append("5. I have read this agreement and accept it of my own free will.");
        return t.toString();
    }

    private HostedChitAgreement agreementOf(HostedChit c, int monthNo) {
        return agreements.findByChitId(c.getId()).stream().filter(a -> a.getMonthNo() == monthNo).findFirst().orElse(null);
    }

    private HostedChitAgreement requireAgreement(HostedChit c, Long id) {
        return agreements.findById(id).filter(a -> a.getChitId().equals(c.getId())).orElseThrow(() -> new NotFoundException("Agreement", id));
    }

    private void dropAgreement(HostedChit c, HostedChitAgreement a) {
        shares.deleteAll(shares.findByChitId(c.getId()).stream().filter(x -> a.getId().equals(x.getAgreementId())).toList());
        agreements.deleteById(a.getId());
    }

    private static String ordinal(int n) {
        int v = n % 100;
        String suffix = v >= 11 && v <= 13 ? "th" : switch (n % 10) { case 1 -> "st"; case 2 -> "nd"; case 3 -> "rd"; default -> "th"; };
        return n + suffix;
    }

    static String sha256(String text) {
        try {
            byte[] hash = java.security.MessageDigest.getInstance("SHA-256").digest(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return java.util.HexFormat.of().formatHex(hash);
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** 475000 -> "Rupees Four Lakh Seventy Five Thousand only" (the Indian way). */
    static String inWords(BigDecimal amount) {
        long n = amount.setScale(0, java.math.RoundingMode.HALF_UP).longValue();
        if (n == 0) return "Rupees Zero only";
        String[] ones = {"", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
                "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"};
        String[] tens = {"", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"};
        java.util.function.IntFunction<String> two = x -> x < 20 ? ones[x] : (tens[x / 10] + (x % 10 > 0 ? " " + ones[x % 10] : ""));
        StringBuilder b = new StringBuilder();
        long crore = n / 10_000_000; n %= 10_000_000;
        long lakh = n / 100_000; n %= 100_000;
        long thousand = n / 1000; n %= 1000;
        long hundred = n / 100; n %= 100;
        if (crore > 0) b.append(crore < 100 ? two.apply((int) crore) : inWords(BigDecimal.valueOf(crore)).replace("Rupees ", "").replace(" only", "")).append(" Crore ");
        if (lakh > 0) b.append(two.apply((int) lakh)).append(" Lakh ");
        if (thousand > 0) b.append(two.apply((int) thousand)).append(" Thousand ");
        if (hundred > 0) b.append(ones[(int) hundred]).append(" Hundred ");
        if (n > 0) b.append(b.length() > 0 ? "and " : "").append(two.apply((int) n));
        return "Rupees " + b.toString().trim() + " only";
    }

    private static AgreementView agreementView(HostedChitAgreement a, Map<Long, String> names) {
        return new AgreementView(a.getId(), a.getMonthNo(), a.getMemberId(), names.get(a.getMemberId()), a.getAgreementNo(), a.getChitValue(),
                a.getDeduction(), a.getPayoutAmount(), a.getPayoutDate(), a.getPayoutMode(), a.getPayoutReference(), a.getRemainingInstallments(),
                a.getRemainingAmount(), a.getGuarantorName(), a.getGuarantorPhone(), a.getTerms(), a.getContentHash(), a.getStatus(),
                a.getAcceptedName(), a.getAcceptedAt(), a.getAcceptedFrom(), a.getAcceptedPhone(), a.getPhoneMatches(), a.getAcceptedIp(),
                a.getAcceptedDevice(), a.getDeviceHash(), a.getAcceptedLocation(), a.getSignature(), a.getAcceptanceSeal(), a.getCreatedAt());
    }

    // ================================================================== report

    public record ReportMonth(String month, BigDecimal collected, BigDecimal paidOut, BigDecimal commission, BigDecimal lateFees) {
    }

    public record ReportChit(Long id, String name, String chitType, String status, int memberCount, int months, int currentMonth,
                             int completedMonths, BigDecimal chitValue, BigDecimal installment, BigDecimal collected, BigDecimal paidOut,
                             BigDecimal commission, BigDecimal lateFees, BigDecimal pendingDues, BigDecimal lateFeesDue, BigDecimal held,
                             BigDecimal collectedThisMonth, BigDecimal expectedThisMonth, int agreementsAccepted, int agreementsPending,
                             int payoutsWithoutAgreement, LocalDate nextDueDate) {
    }

    /** A member who owes money now (installments past their due date, and late interest). */
    public record ReportDefaulter(Long chitId, String chitName, Long memberId, String member, String phone, int monthsOverdue,
                                  LocalDate oldestDue, int daysLate, BigDecimal overdue, BigDecimal lateFeeDue) {
    }

    public record ReportAging(String label, int count, BigDecimal amount) {
    }

    /** Hosted chits for the Reports page: totals for a period (by the date money moved) and dues as of today. */
    public record Report(LocalDate from, LocalDate to, int running, int finished, int members, BigDecimal collected, BigDecimal paidOut,
                         BigDecimal commission, BigDecimal lateFees, BigDecimal pendingDues, BigDecimal lateFeesDue, BigDecimal held,
                         BigDecimal collectedThisMonth, BigDecimal expectedThisMonth, List<ReportChit> chits, List<ReportMonth> months,
                         List<ReportAging> aging, List<ReportDefaulter> defaulters) {
    }

    public Report report(LocalDate from, LocalDate to) {
        LocalDate start = from != null ? from : LocalDate.now().withDayOfMonth(1).minusMonths(11);
        LocalDate end = to != null ? to : LocalDate.now();
        LocalDate today = LocalDate.now();
        Map<String, BigDecimal[]> byMonth = new java.util.LinkedHashMap<>();
        for (YearMonth ym = YearMonth.from(start); !ym.isAfter(YearMonth.from(end)); ym = ym.plusMonths(1)) {
            byMonth.put(ym.toString(), new BigDecimal[] {Money.ZERO, Money.ZERO, Money.ZERO, Money.ZERO});
        }
        String[] labels = {"Due, not late yet", "1–30 days late", "31–60 days late", "61–90 days late", "Over 90 days late"};
        int[] agingCount = new int[5];
        BigDecimal[] agingAmount = {Money.ZERO, Money.ZERO, Money.ZERO, Money.ZERO, Money.ZERO};
        List<ReportChit> rows = new ArrayList<>();
        List<ReportDefaulter> defaulters = new ArrayList<>();
        BigDecimal[] totals = {Money.ZERO, Money.ZERO, Money.ZERO, Money.ZERO};
        int members = 0;
        for (HostedChit c : chits.findByTenantId(UserContext.tenantId())) {
            Calc calc = new Calc(c);
            ChitView v = calc.view();
            members += calc.memberList.size();
            BigDecimal collected = Money.ZERO, late = Money.ZERO, paidOut = Money.ZERO, commission = Money.ZERO;
            for (HostedChitPayment p : calc.paymentList) {
                if (p.getPaidDate().isBefore(start) || p.getPaidDate().isAfter(end)) continue;
                collected = collected.add(p.getAmount());
                late = late.add(Money.nz(p.getLateFee()));
                BigDecimal[] m = byMonth.get(YearMonth.from(p.getPaidDate()).toString());
                if (m != null) { m[0] = m[0].add(p.getAmount()); m[3] = m[3].add(Money.nz(p.getLateFee())); }
            }
            for (HostedChitMonth m : calc.monthList) {
                if (m.getPayoutDate() == null || m.getPayoutDate().isBefore(start) || m.getPayoutDate().isAfter(end)) continue;
                paidOut = paidOut.add(Money.nz(m.getPayoutAmount()));
                commission = commission.add(Money.nz(m.getCommissionAmount()));
                BigDecimal[] x = byMonth.get(YearMonth.from(m.getPayoutDate()).toString());
                if (x != null) { x[1] = x[1].add(Money.nz(m.getPayoutAmount())); x[2] = x[2].add(Money.nz(m.getCommissionAmount())); }
            }
            totals[0] = totals[0].add(collected);
            totals[1] = totals[1].add(paidOut);
            totals[2] = totals[2].add(commission);
            totals[3] = totals[3].add(late);
            // dues as of today, by how late they are, and who owes
            for (HostedChitMember mem : calc.memberList) {
                BigDecimal overdue = Money.ZERO;
                int monthsOverdue = 0;
                LocalDate oldest = null;
                BigDecimal lateDue = Money.ZERO;
                for (int no = 1; no <= c.getMonths(); no++) {
                    if (!calc.due(no)) continue;
                    lateDue = lateDue.add(calc.lateDue(mem.getId(), no));
                    BigDecimal rest = calc.due(mem.getId(), no).subtract(calc.paid(mem.getId(), no));
                    if (rest.signum() <= 0) continue;
                    LocalDate dueOn = dueDate(c, no);
                    long days = java.time.temporal.ChronoUnit.DAYS.between(dueOn, today);
                    int bucket = days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;
                    agingCount[bucket]++;
                    agingAmount[bucket] = agingAmount[bucket].add(rest);
                    if (days > 0) {
                        overdue = overdue.add(rest);
                        monthsOverdue++;
                        if (oldest == null) oldest = dueOn;
                    }
                }
                if (overdue.signum() > 0 || lateDue.signum() > 0) {
                    defaulters.add(new ReportDefaulter(c.getId(), c.getName(), mem.getId(), mem.getName(), mem.getPhone(), monthsOverdue, oldest,
                            oldest == null ? 0 : (int) java.time.temporal.ChronoUnit.DAYS.between(oldest, today), overdue, lateDue));
                }
            }
            List<HostedChitAgreement> ags = agreements.findByChitId(c.getId());
            int accepted = (int) ags.stream().filter(a -> !HostedChitAgreement.DRAFT.equals(a.getStatus())).count();
            int without = (int) calc.monthList.stream().filter(m -> m.getPayoutDate() != null)
                    .filter(m -> ags.stream().noneMatch(a -> a.getMonthNo().equals(m.getMonthNo()))).count();
            rows.add(new ReportChit(c.getId(), c.getName(), v.chitType(), c.getStatus(), v.memberCount(), v.months(), v.currentMonth(),
                    v.completedMonths(), v.currentChitValue(), v.installment(), collected, paidOut, commission, late, v.pendingDues(),
                    v.lateFeesDue(), v.held(), v.collectedThisMonth(), v.expectedThisMonth(), accepted, ags.size() - accepted, without,
                    v.nextDueDate()));
        }
        rows.sort(Comparator.comparing((ReportChit r) -> HostedChit.COMPLETED.equals(r.status())).thenComparing(ReportChit::name));
        defaulters.sort(Comparator.comparing((ReportDefaulter d) -> d.overdue().add(d.lateFeeDue())).reversed());
        List<ReportMonth> monthRows = byMonth.entrySet().stream()
                .map(e -> new ReportMonth(e.getKey(), e.getValue()[0], e.getValue()[1], e.getValue()[2], e.getValue()[3])).toList();
        List<ReportAging> aging = new ArrayList<>();
        for (int i = 0; i < 5; i++) aging.add(new ReportAging(labels[i], agingCount[i], agingAmount[i]));
        Function<Function<ReportChit, BigDecimal>, BigDecimal> sum = f -> rows.stream().filter(r -> HostedChit.ACTIVE.equals(r.status()))
                .map(f).reduce(Money.ZERO, BigDecimal::add);
        return new Report(start, end, (int) rows.stream().filter(r -> HostedChit.ACTIVE.equals(r.status())).count(),
                (int) rows.stream().filter(r -> !HostedChit.ACTIVE.equals(r.status())).count(), members,
                totals[0], totals[1], totals[2], totals[3], sum.apply(ReportChit::pendingDues), sum.apply(ReportChit::lateFeesDue),
                sum.apply(ReportChit::held), sum.apply(ReportChit::collectedThisMonth), sum.apply(ReportChit::expectedThisMonth),
                rows, monthRows, aging, defaulters.stream().limit(25).toList());
    }

    // ================================================================== helpers

    private HostedChit require(Long id) {
        return chits.findByIdAndTenantId(id, UserContext.tenantId()).orElseThrow(() -> new NotFoundException("Hosted chit", id));
    }

    private HostedChitMember requireMember(HostedChit c, Long memberId) {
        return members.findById(memberId).filter(m -> m.getChitId().equals(c.getId()))
                .orElseThrow(() -> new NotFoundException("Member", memberId));
    }

    private HostedChitPayment requirePayment(HostedChit c, Long paymentId) {
        return payments.findById(paymentId).filter(p -> p.getChitId().equals(c.getId()))
                .orElseThrow(() -> new NotFoundException("Payment", paymentId));
    }

    private static boolean hasPayments(Calc calc, int monthNo) {
        return calc.paymentList.stream().anyMatch(p -> p.getMonthNo() == monthNo);
    }

    /**
     * Members: names present and different from each other, a phone that is a 10-digit Indian mobile number (a +91
     * or 0 in front is dropped), an e-mail that looks like one.
     */
    static List<MemberInput> cleanMembers(List<MemberInput> list) {
        java.util.Set<String> seen = new HashSet<>();
        List<MemberInput> out = new ArrayList<>();
        for (MemberInput m : list) {
            String name = m.name() == null ? "" : m.name().trim().replaceAll("\\s+", " ");
            if (name.isEmpty()) throw new BusinessException("Every member needs a name");
            if (!seen.add(name.toLowerCase(java.util.Locale.ROOT))) {
                throw new BusinessException("Two members are called \"" + name + "\"; add a surname or an initial");
            }
            out.add(new MemberInput(name, cleanPhone(m.phone(), name), m.email() == null || m.email().isBlank() ? null : m.email().trim()));
        }
        return out;
    }

    static String cleanPhone(String phone, String name) {
        if (phone == null || phone.isBlank()) return null;
        String digits = phone.replaceAll("\\D", "");
        if (digits.length() == 12 && digits.startsWith("91")) digits = digits.substring(2);
        if (digits.length() == 11 && digits.startsWith("0")) digits = digits.substring(1);
        if (!digits.matches("[6-9]\\d{9}")) {
            throw new BusinessException(name + ": the phone should be a 10-digit mobile number");
        }
        return digits;
    }

    private static void requireMonthNo(HostedChit c, Integer monthNo) {
        if (monthNo == null || monthNo < 1 || monthNo > c.getMonths()) {
            throw new BusinessException("Month must be between 1 and " + c.getMonths());
        }
    }

    private boolean structureLocked(HostedChit c) {
        return !payments.findByChitId(c.getId()).isEmpty()
                || months.findByChitId(c.getId()).stream().anyMatch(m -> m.getWinnerMemberId() != null);
    }

    private static String extraType(HostedChit c) {
        return c.getWinnerExtraType() == null ? EXTRA_NONE : c.getWinnerExtraType();
    }

    /** The rupees a winner pays on top of the installment in each month after winning. */
    static BigDecimal winnerExtra(HostedChit c) {
        BigDecimal value = Money.nz(c.getWinnerExtraValue());
        return switch (extraType(c)) {
            case EXTRA_PERCENT -> Money.round(c.getBaseValue().multiply(value).divide(Money.HUNDRED));
            case EXTRA_FIXED -> Money.round(value);
            default -> Money.ZERO;
        };
    }

    static LocalDate dueDate(HostedChit c, int monthNo) {
        YearMonth ym = YearMonth.from(c.getStartMonth()).plusMonths(monthNo - 1L);
        return ym.atDay(Math.min(c.getDueDay(), ym.lengthOfMonth()));
    }

    private static String mode(String mode) {
        if (mode == null || mode.isBlank()) return "Cash";
        return MODES.stream().filter(m -> m.equalsIgnoreCase(mode.trim())).findFirst()
                .orElseThrow(() -> new BusinessException("Mode must be Cash, UPI or Bank"));
    }

    private static String blank(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }

    /** The liability that holds the members' money between collection and payout (created on first use). */
    private Account fundsAccount() {
        Long tenantId = UserContext.tenantId();
        return accounts.findByTenantId(tenantId).stream()
                .filter(a -> Boolean.TRUE.equals(a.getSystemAccount()) && a.getAccountClass() == AccountClass.LIABILITY
                        && FUNDS_ACCOUNT.equals(a.getName()))
                .findFirst()
                .orElseGet(() -> accountService.createInternal(FUNDS_ACCOUNT, AccountType.OTHER_LIABILITY,
                        "Members' money collected in chits you run, until it is paid out", true));
    }

    /**
     * The income category for the commission (and late interest): the one chosen for the chit, otherwise a separate
     * "Chit Commission Income" category, made on first use.
     */
    private Category commissionCategory(HostedChit c) {
        if (c.getCommissionCategoryId() != null) {
            Optional<Category> chosen = categoryRepository.findByIdAndTenantId(c.getCommissionCategoryId(), UserContext.tenantId());
            if (chosen.isPresent()) return chosen.get();
        }
        return categoryRepository.findByName(UserContext.tenantId(), CategoryKind.INCOME, COMMISSION_CATEGORY)
                .orElseGet(() -> categoryService.require(categoryService.create(new CategoryRequest(CategoryKind.INCOME, COMMISSION_CATEGORY,
                        null, "Commission and late payment interest from the chits I run (Host a Chit)", true, null)).id()));
    }

    /** Late payment interest is booked under its own income category, made on first use. */
    private Category lateFeeCategory() {
        return categoryRepository.findByName(UserContext.tenantId(), CategoryKind.INCOME, LATE_FEE_CATEGORY)
                .orElseGet(() -> categoryService.require(categoryService.create(new CategoryRequest(CategoryKind.INCOME, LATE_FEE_CATEGORY,
                        null, "Interest on late installments from the chits I run (Host a Chit)", true, null)).id()));
    }

    static boolean auction(HostedChit c) {
        return HostedChit.TYPE_AUCTION.equals(c.getChitType());
    }

    /** Auction chits: the highest bid allowed (maxBidPercent of the chit value). */
    static BigDecimal maxBid(HostedChit c) {
        BigDecimal pct = c.getMaxBidPercent() == null ? BigDecimal.valueOf(40) : c.getMaxBidPercent();
        return Money.round(c.getBaseValue().multiply(pct).divide(Money.HUNDRED));
    }

    // ================================================================== figures

    /** Everything about one chit, worked out once from its rows. */
    private final class Calc {

        final HostedChit c;
        final List<HostedChitMember> memberList;
        final List<HostedChitMonth> monthList;
        final List<HostedChitPayment> paymentList;
        final Map<Long, Map<Integer, BigDecimal>> paid = new HashMap<>();
        final Map<Long, Integer> won = new HashMap<>();
        final int completedMonths;
        /** The first month not paid out (months + 1 when all are). */
        final int currentMonth;
        final LocalDate today = LocalDate.now();

        Calc(HostedChit c) {
            this.c = c;
            this.memberList = members.findByChitId(c.getId()).stream().sorted(Comparator.comparing(HostedChitMember::getSlot)).toList();
            this.monthList = months.findByChitId(c.getId()).stream().sorted(Comparator.comparing(HostedChitMonth::getMonthNo)).toList();
            this.paymentList = payments.findByChitId(c.getId()).stream()
                    .sorted(Comparator.comparing(HostedChitPayment::getPaidDate).thenComparing(HostedChitPayment::getId)).toList();
            for (HostedChitPayment p : paymentList) {
                paid.computeIfAbsent(p.getMemberId(), k -> new HashMap<>()).merge(p.getMonthNo(), p.getAmount(), BigDecimal::add);
            }
            monthList.stream().filter(m -> m.getWinnerMemberId() != null).forEach(m -> won.put(m.getWinnerMemberId(), m.getMonthNo()));
            this.completedMonths = (int) monthList.stream().filter(m -> m.getPayoutDate() != null).count();
            this.currentMonth = monthList.stream().filter(m -> m.getPayoutDate() == null).mapToInt(HostedChitMonth::getMonthNo)
                    .min().orElse(c.getMonths() + 1);
        }

        BigDecimal paid(Long memberId, int monthNo) {
            return paid.getOrDefault(memberId, Map.of()).getOrDefault(monthNo, Money.ZERO);
        }

        Integer wonMonth(Long memberId) {
            return won.get(memberId);
        }

        /** What a member owes for a month: the installment, plus the winner extra in months after their win. */
        BigDecimal due(Long memberId, int monthNo) {
            if (auction(c)) return c.getInstallment().subtract(dividend(monthNo));
            Integer w = won.get(memberId);
            return w != null && w < monthNo ? c.getInstallment().add(winnerExtra(c)) : c.getInstallment();
        }

        /**
         * Late interest on a member's month: simple interest at lateFeePercent a month (by the day, 30-day month) on
         * what was still unpaid, from the due date plus the grace days until it was paid (or today).
         */
        BigDecimal lateAccrued(Long memberId, int monthNo) {
            BigDecimal rate = Money.nz(c.getLateFeePercent());
            if (rate.signum() <= 0) return Money.ZERO;
            LocalDate start = dueDate(c, monthNo).plusDays(c.getLateGraceDays() == null ? 0 : c.getLateGraceDays());
            if (!today.isAfter(start)) return Money.ZERO;
            BigDecimal outstanding = due(memberId, monthNo);
            BigDecimal dayRate = rate.divide(BigDecimal.valueOf(3000), 10, java.math.RoundingMode.HALF_UP);
            BigDecimal interest = BigDecimal.ZERO;
            LocalDate from = start;
            for (HostedChitPayment p : paymentList) {
                if (!p.getMemberId().equals(memberId) || p.getMonthNo() != monthNo || Money.nz(p.getAmount()).signum() <= 0) continue;
                if (p.getPaidDate().isAfter(from) && outstanding.signum() > 0) {
                    long days = java.time.temporal.ChronoUnit.DAYS.between(from, p.getPaidDate());
                    interest = interest.add(outstanding.multiply(dayRate).multiply(BigDecimal.valueOf(days)));
                    from = p.getPaidDate();
                }
                outstanding = outstanding.subtract(p.getAmount());
            }
            if (outstanding.signum() > 0 && today.isAfter(from)) {
                interest = interest.add(outstanding.multiply(dayRate).multiply(BigDecimal.valueOf(java.time.temporal.ChronoUnit.DAYS.between(from, today))));
            }
            return interest.setScale(0, java.math.RoundingMode.HALF_UP).setScale(2);
        }

        /** Late interest already collected or let off for a member's month. */
        BigDecimal lateSettled(Long memberId, int monthNo, Long ignorePaymentId) {
            return paymentList.stream().filter(p -> p.getMemberId().equals(memberId) && p.getMonthNo() == monthNo && !p.getId().equals(ignorePaymentId))
                    .map(p -> Money.nz(p.getLateFee()).add(Money.nz(p.getLateFeeWaived()))).reduce(Money.ZERO, BigDecimal::add);
        }

        BigDecimal lateDue(Long memberId, int monthNo) {
            return lateAccrued(memberId, monthNo).subtract(lateSettled(memberId, monthNo, null)).max(Money.ZERO);
        }

        int daysLate(Long memberId, int monthNo) {
            LocalDate start = dueDate(c, monthNo).plusDays(c.getLateGraceDays() == null ? 0 : c.getLateGraceDays());
            if (!today.isAfter(start) || paid(memberId, monthNo).compareTo(due(memberId, monthNo)) >= 0) return 0;
            return (int) java.time.temporal.ChronoUnit.DAYS.between(dueDate(c, monthNo), today);
        }

        BigDecimal expected(int monthNo) {
            return memberList.stream().map(m -> due(m.getId(), monthNo)).reduce(Money.ZERO, BigDecimal::add);
        }

        HostedChitMonth month(int monthNo) {
            return monthList.stream().filter(m -> m.getMonthNo() == monthNo).findFirst()
                    .orElseThrow(() -> new BusinessException("Month must be between 1 and " + c.getMonths()));
        }

        BigDecimal chitValue(int monthNo) {
            return auction(c) ? c.getBaseValue() : c.getBaseValue().add(c.getMonthlyIncrement().multiply(BigDecimal.valueOf(monthNo - 1L)));
        }

        /** Auction chits: each member's share of the month's bid, less the commission (whole rupees). */
        BigDecimal dividend(int monthNo) {
            if (!auction(c)) return Money.ZERO;
            BigDecimal bid = monthList.stream().filter(m -> m.getMonthNo() == monthNo).findFirst().map(HostedChitMonth::getBidAmount).orElse(null);
            if (bid == null || bid.compareTo(c.getCommission()) <= 0) return Money.ZERO;
            return Money.round(bid.subtract(c.getCommission()).divide(BigDecimal.valueOf(memberList.size()), 0, java.math.RoundingMode.DOWN));
        }

        /** Installments of this month are due: it is the current month (or earlier), or its due date has come. */
        boolean due(int monthNo) {
            return monthNo <= currentMonth || !dueDate(c, monthNo).isAfter(today);
        }

        BigDecimal collected(int monthNo) {
            return memberList.stream().map(m -> paid(m.getId(), monthNo)).reduce(Money.ZERO, BigDecimal::add);
        }

        BigDecimal dues(Long memberId) {
            BigDecimal total = Money.ZERO;
            for (int no = 1; no <= c.getMonths(); no++) {
                if (!due(no)) continue;
                BigDecimal rest = due(memberId, no).subtract(paid(memberId, no));
                if (rest.signum() > 0) total = total.add(rest);
            }
            return total;
        }

        ChitView view() {
            int shown = Math.min(currentMonth, c.getMonths());
            BigDecimal totalCollected = paymentList.stream().map(HostedChitPayment::getAmount).reduce(Money.ZERO, BigDecimal::add);
            BigDecimal paidOut = monthList.stream().map(m -> Money.nz(m.getPayoutAmount())).reduce(Money.ZERO, BigDecimal::add);
            BigDecimal commission = monthList.stream().map(m -> Money.nz(m.getCommissionAmount())).reduce(Money.ZERO, BigDecimal::add);
            BigDecimal pending = Money.ZERO;
            int pendingCount = 0;
            for (HostedChitMember m : memberList) {
                for (int no = 1; no <= c.getMonths(); no++) {
                    if (!due(no)) continue;
                    BigDecimal rest = due(m.getId(), no).subtract(paid(m.getId(), no));
                    if (rest.signum() > 0) {
                        pending = pending.add(rest);
                        pendingCount++;
                    }
                }
            }
            LocalDate next = null;
            if (currentMonth <= c.getMonths()) {
                next = dueDate(c, currentMonth);
                for (int no = currentMonth; no <= c.getMonths(); no++) {
                    if (!dueDate(c, no).isBefore(today)) {
                        next = dueDate(c, no);
                        break;
                    }
                }
            }
            String accountName = c.getAccountId() == null ? null
                    : accounts.findById(c.getAccountId()).map(Account::getName).orElse(null);
            String commissionAccountName = c.getCommissionAccountId() == null ? null
                    : accounts.findById(c.getCommissionAccountId()).map(Account::getName).orElse(null);
            Category category = c.getCommissionCategoryId() == null ? null
                    : categoryRepository.findById(c.getCommissionCategoryId()).orElse(null);
            boolean locked = !paymentList.isEmpty() || !won.isEmpty();
            BigDecimal lateCollected = paymentList.stream().map(p -> Money.nz(p.getLateFee())).reduce(Money.ZERO, BigDecimal::add);
            BigDecimal lateOpen = Money.ZERO;
            if (Money.isPositive(c.getLateFeePercent())) {
                for (HostedChitMember m : memberList) {
                    for (int no = 1; no <= c.getMonths(); no++) {
                        if (due(no)) lateOpen = lateOpen.add(lateDue(m.getId(), no));
                    }
                }
            }
            return new ChitView(c.getId(), c.getName(), auction(c) ? HostedChit.TYPE_AUCTION : HostedChit.TYPE_FIXED, c.getStartMonth(), c.getDueDay(), c.getMemberCount(), c.getMonths(),
                    c.getInstallment(), c.getBaseValue(), c.getMonthlyIncrement(), c.getCommission(),
                    extraType(c), Money.nz(c.getWinnerExtraValue()), winnerExtra(c),
                    auction(c) ? c.getMaxBidPercent() : null, auction(c) ? c.getCommission() : null, auction(c) ? maxBid(c) : null,
                    c.getLateFeePercent(), c.getLateGraceDays() == null ? 0 : c.getLateGraceDays(), c.getUpiId(), c.getPayeeName(),
                    c.getReceiptSignature(), c.getReceiptSigner(),
                    lateCollected, lateOpen,
                    Boolean.TRUE.equals(c.getPostToBooks()), c.getAccountId(), accountName, c.getCommissionAccountId(),
                    commissionAccountName, c.getCommissionCategoryId(), category == null ? null : category.getName(),
                    c.getLateFeeAccountId(), c.getLateFeeAccountId() == null ? null : accounts.findById(c.getLateFeeAccountId()).map(Account::getName).orElse(null),
                    c.getStatus(),
                    Boolean.TRUE.equals(c.getDemo()), c.getNotes(), shown, completedMonths, chitValue(shown),
                    collected(shown), expected(shown),
                    (int) memberList.stream().filter(m -> paid(m.getId(), shown).compareTo(due(m.getId(), shown)) >= 0).count(),
                    totalCollected, paidOut, commission, pending, pendingCount,
                    totalCollected.subtract(paidOut).subtract(commission), next, locked,
                    c.getCreatedBy(), c.getCreatedAt(), c.getVersion());
        }

        Detail detail() {
            Map<Long, String> names = memberList.stream().collect(Collectors.toMap(HostedChitMember::getId, HostedChitMember::getName));
            Set<Long> entryIds = new HashSet<>();
            paymentList.forEach(p -> { if (p.getJournalEntryId() != null) entryIds.add(p.getJournalEntryId()); });
            monthList.forEach(m -> {
                if (m.getPayoutEntryId() != null) entryIds.add(m.getPayoutEntryId());
                if (m.getCommissionEntryId() != null) entryIds.add(m.getCommissionEntryId());
            });
            Map<Long, String> entryNos = new HashMap<>();   // looked up with null ids too, so not Map.of()
            entries.findAllById(entryIds).forEach(e -> entryNos.put(e.getId(), e.getEntryNo()));

            List<MemberView> memberViews = memberList.stream().map(m -> new MemberView(m.getId(), m.getSlot(), m.getName(), m.getPhone(), m.getEmail(),
                    wonMonth(m.getId()),
                    paid.getOrDefault(m.getId(), Map.of()).values().stream().reduce(Money.ZERO, BigDecimal::add),
                    dues(m.getId()), lateDueOf(m.getId()), m.getVersion())).toList();

            List<MonthView> schedule = monthList.stream().map(m -> {
                int no = m.getMonthNo();
                BigDecimal value = chitValue(no);
                boolean done = m.getPayoutDate() != null;
                BigDecimal commission = done ? Money.nz(m.getCommissionAmount()) : c.getCommission();
                boolean bidKnown = m.getBidAmount() != null;
                BigDecimal payout = done ? Money.nz(m.getPayoutAmount())
                        : auction(c) ? value.subtract(bidKnown ? m.getBidAmount() : c.getCommission()) : value.subtract(c.getCommission());
                boolean estimated = auction(c) && !done && !bidKnown;
                int paidCount = (int) memberList.stream().filter(x -> paid(x.getId(), no).compareTo(due(x.getId(), no)) >= 0).count();
                String status = done ? "COMPLETED" : no == currentMonth ? "ONGOING" : "UPCOMING";
                return new MonthView(m.getId(), no, dueDate(c, no), c.getInstallment(), value, payout, estimated,
                        m.getBidAmount(), dividend(no), commission,
                        m.getWinnerMemberId(), names.get(m.getWinnerMemberId()), m.getDrawMethod(), status, due(no),
                        collected(no), expected(no), paidCount, m.getPayoutDate(), m.getPayoutMode(), m.getPayoutReference(),
                        entryNos.get(m.getPayoutEntryId()), m.getPayoutEntryId(), m.getVersion());
            }).toList();

            Map<Long, Integer> files = entryIds.isEmpty() ? Map.of() : attachments.countsByEntry(c.getTenantId());
            List<PaymentView> paymentViews = paymentList.stream().map(p -> new PaymentView(p.getId(), p.getMemberId(),
                    names.get(p.getMemberId()), p.getMonthNo(), p.getAmount(), p.getLateFee(), p.getLateFeeWaived(), p.getReference(),
                    p.getReceiptNo(), p.getPaidDate(), p.getMode(), p.getNote(), entryNos.get(p.getJournalEntryId()), p.getJournalEntryId(),
                    p.getJournalEntryId() == null ? 0 : files.getOrDefault(p.getJournalEntryId(), 0), p.getCreatedBy(), p.getCreatedAt(),
                    p.getVersion())).toList();
            List<LateFeeView> lateFees = new ArrayList<>();
            if (Money.isPositive(c.getLateFeePercent())) {
                for (HostedChitMember m : memberList) {
                    for (int no = 1; no <= c.getMonths(); no++) {
                        BigDecimal accrued = lateAccrued(m.getId(), no);
                        if (accrued.signum() <= 0) continue;
                        BigDecimal settled = lateSettled(m.getId(), no, null);
                        lateFees.add(new LateFeeView(m.getId(), no, daysLate(m.getId(), no), accrued, settled, accrued.subtract(settled).max(Money.ZERO)));
                    }
                }
            }
            List<AgreementView> agreementViews = agreements.findByChitId(c.getId()).stream()
                    .sorted(Comparator.comparing(HostedChitAgreement::getMonthNo)).map(a -> agreementView(a, names)).toList();

            // the ledger: every collection, payout and commission by date, with what is held after each
            record Line(LocalDate date, int order, String kind, int monthNo, String party, String mode, BigDecimal in, BigDecimal out,
                        String entryNo, String note, Long paymentId) {
            }
            List<Line> lines = new ArrayList<>();
            paymentList.forEach(p -> {
                if (Money.isPositive(p.getAmount())) {
                    lines.add(new Line(p.getPaidDate(), 0, "COLLECTION", p.getMonthNo(), names.get(p.getMemberId()), p.getMode(), p.getAmount(),
                            Money.ZERO, entryNos.get(p.getJournalEntryId()), p.getReference() != null ? p.getReference() : p.getNote(), p.getId()));
                }
                if (Money.isPositive(p.getLateFee())) {
                    // late interest is the organiser's: shown, but not part of the members' money held
                    lines.add(new Line(p.getPaidDate(), 0, "LATE_FEE", p.getMonthNo(), names.get(p.getMemberId()), p.getMode(), Money.ZERO,
                            Money.ZERO, entryNos.get(p.getJournalEntryId()), "Late payment interest " + ActivityService.money(p.getLateFee()), p.getId()));
                }
            });
            monthList.stream().filter(m -> m.getPayoutDate() != null).forEach(m -> {
                lines.add(new Line(m.getPayoutDate(), 1, "PAYOUT", m.getMonthNo(), names.get(m.getWinnerMemberId()), m.getPayoutMode(),
                        Money.ZERO, Money.nz(m.getPayoutAmount()), entryNos.get(m.getPayoutEntryId()), m.getDrawMethod(), null));
                if (Money.isPositive(m.getCommissionAmount())) {
                    lines.add(new Line(m.getPayoutDate(), 2, "COMMISSION", m.getMonthNo(), "Organiser commission", null,
                            Money.ZERO, m.getCommissionAmount(), entryNos.get(m.getCommissionEntryId()), null, null));
                }
            });
            lines.sort(Comparator.comparing(Line::date).thenComparing(Line::order).thenComparing(Line::monthNo));
            List<LedgerRow> ledgerRows = new ArrayList<>();
            BigDecimal held = Money.ZERO;
            for (Line l : lines) {
                held = held.add(l.in()).subtract(l.out());
                ledgerRows.add(new LedgerRow(l.date(), l.kind(), l.monthNo(), l.party(), l.mode(), l.in(), l.out(), held, l.entryNo(),
                        l.note(), l.paymentId()));
            }
            return new Detail(view(), memberViews, schedule, paymentViews, ledgerRows, lateFees, agreementViews);
        }

        BigDecimal lateDueOf(Long memberId) {
            if (!Money.isPositive(c.getLateFeePercent())) return Money.ZERO;
            BigDecimal total = Money.ZERO;
            for (int no = 1; no <= c.getMonths(); no++) {
                if (due(no)) total = total.add(lateDue(memberId, no));
            }
            return total;
        }
    }
}
