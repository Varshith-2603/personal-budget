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
import com.aditya.personalbudget.dto.PlanningDtos.CategoryRequest;
import com.aditya.personalbudget.exception.BusinessException;
import com.aditya.personalbudget.exception.NotFoundException;
import com.aditya.personalbudget.repository.AccountRepository;
import com.aditya.personalbudget.repository.CategoryRepository;
import com.aditya.personalbudget.repository.HostedChitMemberRepository;
import com.aditya.personalbudget.repository.HostedChitMonthRepository;
import com.aditya.personalbudget.repository.HostedChitPaymentRepository;
import com.aditya.personalbudget.repository.HostedChitRepository;
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
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Random;
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
 * Books (only when the chit's {@code postToBooks} is on):
 * <ul>
 *   <li><b>Collection</b>: Dr cash / bank / Cr Hosted Chit Funds (a liability: the members' money, held)</li>
 *   <li><b>Payout</b>: Dr Hosted Chit Funds / Cr cash / bank ("Chit payout - member")</li>
 *   <li><b>Commission</b>: Dr Hosted Chit Funds / Cr Income [Chit Commission] ("Chit commission - chit")</li>
 * </ul>
 * so the balance sheet shows what is held (collected and not yet paid out) as a liability, and only the commission
 * is income. Every change writes its own activity line (the generic recorder skips these calls).
 */
@Service
public class HostedChitService {

    public static final String SOURCE_COLLECTION = "HOSTED_CHIT_COLLECTION";
    public static final String SOURCE_PAYOUT = "HOSTED_CHIT_PAYOUT";
    public static final String SOURCE_COMMISSION = "HOSTED_CHIT_COMMISSION";
    static final String FUNDS_ACCOUNT = "Hosted Chit Funds";
    static final String COMMISSION_CATEGORY = "Chit Commission";
    private static final String AREA = "Host a Chit";
    private static final Set<String> MODES = Set.of("Cash", "UPI", "Bank");

    // ================================================================== requests

    public record MemberInput(@NotBlank @Size(max = 100) String name, @Size(max = 20) String phone) {
    }

    public record ChitRequest(
            @NotBlank @Size(max = 100) String name,
            @NotNull LocalDate startMonth,
            @Min(1) @Max(28) Integer dueDay,
            @NotNull @Min(2) @Max(100) Integer memberCount,
            @NotNull @Min(2) @Max(100) Integer months,
            @NotNull @Positive BigDecimal installment,
            @NotNull @Positive BigDecimal baseValue,
            @NotNull @PositiveOrZero BigDecimal monthlyIncrement,
            @NotNull @PositiveOrZero BigDecimal commission,
            Boolean postToBooks,
            Long accountId,
            @Size(max = 255) String notes,
            /* only when creating: the members, in order */
            List<@Valid MemberInput> members,
            Long version) {
    }

    public record PaymentRequest(@NotNull Long memberId, @NotNull @Min(1) Integer monthNo, @NotNull @Positive BigDecimal amount,
                                 LocalDate paidDate, String mode, @Size(max = 255) String note,
                                 /* the user confirmed a payment above the installment */
                                 Boolean allowExcess, Long version) {
    }

    public record CollectAllRequest(LocalDate paidDate, String mode) {
    }

    public record WinnerRequest(@NotNull Long memberId, Boolean random) {
    }

    public record PayoutRequest(LocalDate payoutDate, String mode,
                                /* the user confirmed closing the month with unpaid dues */
                                Boolean allowDues) {
    }

    // ================================================================== views

    public record ChitView(Long id, String name, LocalDate startMonth, int dueDay, int memberCount, int months,
                           BigDecimal installment, BigDecimal baseValue, BigDecimal monthlyIncrement, BigDecimal commission,
                           boolean postToBooks, Long accountId, String accountName, String status, boolean demo, String notes,
                           int currentMonth, int completedMonths, BigDecimal currentChitValue,
                           BigDecimal collectedThisMonth, BigDecimal expectedThisMonth, int paidThisMonth,
                           BigDecimal totalCollected, BigDecimal totalPaidOut, BigDecimal commissionEarned,
                           BigDecimal pendingDues, int pendingCount, BigDecimal held, LocalDate nextDueDate,
                           boolean structureLocked, String createdBy, LocalDateTime createdAt, Long version) {
    }

    public record MemberView(Long id, int slot, String name, String phone, Integer wonMonth,
                             BigDecimal totalPaid, BigDecimal balanceDue, Long version) {
    }

    /** status: COMPLETED (payout done), ONGOING (the current month) or UPCOMING. */
    public record MonthView(Long id, int monthNo, LocalDate dueDate, BigDecimal installment, BigDecimal chitValue,
                            BigDecimal payout, BigDecimal commission, Long winnerMemberId, String winnerName, String drawMethod,
                            String status, boolean due, BigDecimal collected, BigDecimal expected, int paidCount,
                            LocalDate payoutDate, String payoutMode, String payoutEntryNo, Long version) {
    }

    public record PaymentView(Long id, Long memberId, String memberName, int monthNo, BigDecimal amount, LocalDate paidDate,
                              String mode, String note, String entryNo, String createdBy, LocalDateTime createdAt, Long version) {
    }

    /**
     * kind: COLLECTION (paymentId set), PAYOUT or COMMISSION; held is the running balance (collected - paid out -
     * commission).
     */
    public record LedgerRow(LocalDate date, String kind, int monthNo, String party, String mode, BigDecimal moneyIn,
                            BigDecimal moneyOut, BigDecimal held, String entryNo, String note, Long paymentId) {
    }

    public record Detail(ChitView chit, List<MemberView> members, List<MonthView> schedule, List<PaymentView> payments,
                         List<LedgerRow> ledger) {
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
    private final AccountRepository accounts;
    private final CategoryRepository categoryRepository;
    private final JournalEntryRepository entries;
    private final AccountService accountService;
    private final CategoryService categoryService;
    private final LedgerService ledger;
    private final ActivityService activity;

    public HostedChitService(HostedChitRepository chits, HostedChitMemberRepository members, HostedChitMonthRepository months,
                             HostedChitPaymentRepository payments, AccountRepository accounts, CategoryRepository categoryRepository,
                             JournalEntryRepository entries, AccountService accountService, CategoryService categoryService,
                             LedgerService ledger, ActivityService activity) {
        this.chits = chits;
        this.members = members;
        this.months = months;
        this.payments = payments;
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
        List<MemberInput> list = r.members() == null ? List.of() : r.members();
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
        apply(c, r);
        c = chits.save(c);
        addMembersAndMonths(c, list);
        activity.record("ADDED", AREA, "Started a hosted chit · " + c.getName() + " · " + ActivityService.money(c.getBaseValue())
                + " · " + c.getMemberCount() + " members");
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

    @Transactional
    public void delete(Long id) {
        HostedChit c = require(id);
        String name = c.getName();
        removeChit(c);
        activity.record("DELETED", AREA, "Deleted a hosted chit · " + name);
    }

    private void apply(HostedChit c, ChitRequest r) {
        c.setName(r.name().trim());
        c.setDueDay(r.dueDay() == null ? 5 : r.dueDay());
        c.setInstallment(Money.round(r.installment()));
        c.setBaseValue(Money.round(r.baseValue()));
        c.setMonthlyIncrement(Money.round(r.monthlyIncrement()));
        c.setCommission(Money.round(r.commission()));
        BigDecimal lastValue = c.getBaseValue().add(c.getMonthlyIncrement().multiply(BigDecimal.valueOf(c.getMonths() - 1L)));
        if (c.getCommission().compareTo(c.getBaseValue()) >= 0) {
            throw new BusinessException("The commission must be less than the chit value (" + ActivityService.money(c.getBaseValue()) + ")");
        }
        if (lastValue.signum() <= 0) {
            throw new BusinessException("The chit value must stay above zero");
        }
        c.setNotes(blank(r.notes()));
        c.setPostToBooks(Boolean.TRUE.equals(r.postToBooks()));
        if (c.getPostToBooks()) {
            Account account = r.accountId() != null ? accountService.require(r.accountId())
                    : accountService.systemAccount(DefaultChartOfAccounts.CASH);
            if (account.getAccountClass() != AccountClass.ASSET || account.getAccountType() == AccountType.CHIT_FUND) {
                throw new BusinessException("Collect into a cash, bank or wallet account");
            }
            c.setAccountId(account.getId());
        } else {
            c.setAccountId(r.accountId());
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
        }
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
        m.setName(ActivityService.cut(r.name().trim(), 100));
        m.setPhone(blank(r.phone()));
        members.save(m);
        activity.record("CHANGED", AREA, "Edited a member · " + c.getName() + " · " + before
                + (before.equals(m.getName()) ? "" : " → " + m.getName()));
        return detail(chitId);
    }

    // ================================================================== collections

    @Transactional
    public Detail addPayment(Long chitId, PaymentRequest r) {
        HostedChit c = require(chitId);
        HostedChitMember member = requireMember(c, r.memberId());
        requireMonthNo(c, r.monthNo());
        BigDecimal amount = Money.round(r.amount());
        checkExcess(c, member, r.monthNo(), amount, null, r.allowExcess());

        HostedChitPayment p = new HostedChitPayment();
        p.setTenantId(c.getTenantId());
        p.setChitId(c.getId());
        p.setMemberId(member.getId());
        p.setMonthNo(r.monthNo());
        p.setAmount(amount);
        p.setPaidDate(r.paidDate() != null ? r.paidDate() : LocalDate.now());
        p.setMode(mode(r.mode()));
        p.setNote(blank(r.note()));
        p.setCreatedBy(UserContext.username());
        p.setCreatedAt(LocalDateTime.now());
        p = payments.save(p);
        if (Boolean.TRUE.equals(c.getPostToBooks())) {
            p.setJournalEntryId(ledger.post(collectionDraft(c, member, p)).getId());
            payments.save(p);
        }
        activity.record("POSTED", AREA, "Collected · " + member.getName() + " · " + c.getName() + " month " + p.getMonthNo()
                + " · " + ActivityService.money(amount) + " · " + p.getMode());
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
        checkExcess(c, member, p.getMonthNo(), amount, p.getId(), r.allowExcess());
        BigDecimal before = p.getAmount();
        p.setAmount(amount);
        if (r.paidDate() != null) p.setPaidDate(r.paidDate());
        p.setMode(mode(r.mode()));
        p.setNote(blank(r.note()));
        if (p.getJournalEntryId() != null) {
            ledger.repost(p.getJournalEntryId(), collectionDraft(c, member, p));
        } else if (Boolean.TRUE.equals(c.getPostToBooks())) {
            p.setJournalEntryId(ledger.post(collectionDraft(c, member, p)).getId());
        }
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
        LocalDate date = r != null && r.paidDate() != null ? r.paidDate() : LocalDate.now();
        String mode = mode(r == null ? null : r.mode());
        int count = 0;
        BigDecimal total = Money.ZERO;
        for (HostedChitMember m : calc.memberList) {
            BigDecimal rest = c.getInstallment().subtract(calc.paid(m.getId(), monthNo));
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

    private void checkExcess(HostedChit c, HostedChitMember m, int monthNo, BigDecimal amount, Long ignorePaymentId, Boolean allow) {
        BigDecimal already = payments.findByChitId(c.getId()).stream()
                .filter(p -> p.getMemberId().equals(m.getId()) && p.getMonthNo() == monthNo && !p.getId().equals(ignorePaymentId))
                .map(HostedChitPayment::getAmount).reduce(Money.ZERO, BigDecimal::add);
        if (already.add(amount).compareTo(c.getInstallment()) > 0 && !Boolean.TRUE.equals(allow)) {
            throw new BusinessException(m.getName() + " would pay " + ActivityService.money(already.add(amount)) + " for month "
                    + monthNo + ", more than the installment of " + ActivityService.money(c.getInstallment()) + ". Confirm to record it anyway.");
        }
    }

    private JournalDraft collectionDraft(HostedChit c, HostedChitMember m, HostedChitPayment p) {
        return JournalDraft.of(p.getPaidDate(), VoucherType.HOSTED_CHIT_COLLECTION,
                        "Chit collection - " + m.getName() + " - " + c.getName() + " month " + p.getMonthNo() + "/" + c.getMonths())
                .debit(c.getAccountId(), p.getAmount(), p.getMode())
                .credit(fundsAccount().getId(), p.getAmount())
                .party(m.getName())
                .source(SOURCE_COLLECTION, p.getId());
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
        month.setWinnerMemberId(member.getId());
        month.setDrawMethod(Boolean.TRUE.equals(r.random()) ? "Random draw" : "Picked");
        months.save(month);
        activity.record("CHANGED", AREA, "Chose the winner · " + c.getName() + " month " + monthNo + " · " + member.getName()
                + " · " + month.getDrawMethod().toLowerCase());
        return detail(chitId);
    }

    @Transactional
    public Detail clearWinner(Long chitId, int monthNo) {
        HostedChit c = require(chitId);
        HostedChitMonth month = new Calc(c).month(monthNo);
        if (month.getPayoutDate() != null) {
            throw new BusinessException("Month " + monthNo + " is paid out and locked; undo the payout first");
        }
        month.setWinnerMemberId(null);
        month.setDrawMethod(null);
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
            BigDecimal rest = c.getInstallment().subtract(calc.paid(m.getId(), monthNo));
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
        BigDecimal value = calc.chitValue(monthNo);
        BigDecimal commission = c.getCommission().min(value);
        BigDecimal payout = value.subtract(commission);
        LocalDate date = r.payoutDate() != null ? r.payoutDate() : LocalDate.now();
        month.setPayoutAmount(payout);
        month.setCommissionAmount(commission);
        month.setPayoutDate(date);
        month.setPayoutMode(mode(r.mode()));
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
                JournalEntry earned = ledger.post(JournalDraft.of(date, VoucherType.INCOME, "Chit commission - " + c.getName() + " month " + monthNo)
                        .debit(funds, commission)
                        .credit(accountService.systemAccount(DefaultChartOfAccounts.INCOME).getId(), commission, "Organiser commission")
                        .category(commissionCategory().getId())
                        .party(c.getName())
                        .source(SOURCE_COMMISSION, month.getId()));
                month.setCommissionEntryId(earned.getId());
            }
        }
        months.save(month);
        if (calc.completedMonths + 1 >= c.getMonths()) {
            c.setStatus(HostedChit.COMPLETED);
            chits.save(c);
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
        List<Long> journal = new ArrayList<>();
        if (month.getPayoutEntryId() != null) journal.add(month.getPayoutEntryId());
        if (month.getCommissionEntryId() != null) journal.add(month.getCommissionEntryId());
        month.setPayoutAmount(null);
        month.setCommissionAmount(null);
        month.setPayoutDate(null);
        month.setPayoutMode(null);
        month.setPayoutEntryId(null);
        month.setCommissionEntryId(null);
        months.save(month);   // release the foreign keys before deleting the journal
        journal.forEach(ledger::delete);
        if (HostedChit.COMPLETED.equals(c.getStatus())) {
            c.setStatus(HostedChit.ACTIVE);
            chits.save(c);
        }
        activity.record("DELETED", AREA, "Undid a payout · " + c.getName() + " month " + monthNo);
        return detail(chitId);
    }

    // ================================================================== demo data

    private static final String[] DEMO_NAMES = {"Ravi Kumar", "Lakshmi Devi", "Suresh Reddy", "Anitha Rao", "Venkatesh",
            "Priya Sharma", "Kiran Babu", "Swathi", "Ramesh Naidu", "Divya", "Srinivas", "Kavitha", "Mahesh", "Sandhya",
            "Naresh", "Padma", "Arjun", "Revathi", "Prakash", "Sunitha"};

    public boolean hasDemo() {
        return chits.findByTenantId(UserContext.tenantId()).stream().anyMatch(c -> Boolean.TRUE.equals(c.getDemo()));
    }

    /**
     * A sample hosted chit: 20 members, months 1-5 closed with a random winner each, most installments paid and a
     * few pending or part paid. Kept out of the books, and removed by {@link #clearDemo}.
     */
    @Transactional
    public Detail loadDemo() {
        if (hasDemo()) {
            throw new BusinessException("The demo chit is already there");
        }
        Random random = new Random();
        // month 6 is the current month: started five months ago (in 2026, as the sample asks)
        YearMonth start = YearMonth.now().minusMonths(5);
        if (start.getYear() != 2026) {
            start = YearMonth.of(2026, 1 + random.nextInt(6));
        }
        List<String> names = new ArrayList<>(List.of(DEMO_NAMES));
        Collections.shuffle(names, random);
        List<MemberInput> list = names.stream()
                .map(n -> new MemberInput(n, String.valueOf(6 + random.nextInt(4)) + String.format("%09d", random.nextInt(1_000_000_000))))
                .toList();

        HostedChit c = new HostedChit();
        c.setTenantId(UserContext.tenantId());
        c.setName("Family Chit 2026");
        c.setStartMonth(start.atDay(1));
        c.setDueDay(5);
        c.setMemberCount(20);
        c.setMonths(20);
        c.setInstallment(Money.of(25000));
        c.setBaseValue(Money.of(500000));
        c.setMonthlyIncrement(Money.of(5000));
        c.setCommission(Money.of(25000));
        c.setPostToBooks(false);
        c.setStatus(HostedChit.ACTIVE);
        c.setDemo(true);
        c.setNotes("Sample data: remove it with Clear demo data");
        c.setCreatedBy(UserContext.username());
        c.setCreatedAt(LocalDateTime.now());
        c = chits.save(c);
        addMembersAndMonths(c, list);

        List<HostedChitMember> people = members.findByChitId(c.getId()).stream()
                .sorted(Comparator.comparing(HostedChitMember::getSlot)).toList();
        List<HostedChitMonth> schedule = months.findByChitId(c.getId()).stream()
                .sorted(Comparator.comparing(HostedChitMonth::getMonthNo)).toList();
        List<HostedChitMember> winners = new ArrayList<>(people);
        Collections.shuffle(winners, random);
        String[] modes = {"Cash", "UPI", "UPI", "Bank"};
        List<HostedChitPayment> rows = new ArrayList<>();
        for (int no = 1; no <= 6; no++) {
            LocalDate due = dueDate(c, no);
            for (HostedChitMember m : people) {
                BigDecimal amount = c.getInstallment();
                double roll = random.nextDouble();
                if (no == 6 && roll < 0.45) continue;                  // the current month: still coming in
                if (no >= 3 && no <= 5 && roll < 0.05) continue;       // a few dues left behind
                if (no >= 3 && roll > 0.95) amount = Money.of(10000 + 5000 * random.nextInt(3));   // part paid
                HostedChitPayment p = new HostedChitPayment();
                p.setTenantId(c.getTenantId());
                p.setChitId(c.getId());
                p.setMemberId(m.getId());
                p.setMonthNo(no);
                p.setAmount(amount);
                LocalDate paid = due.minusDays(3).plusDays(random.nextInt(8));
                p.setPaidDate(paid.isAfter(LocalDate.now()) ? LocalDate.now() : paid);
                p.setMode(modes[random.nextInt(modes.length)]);
                p.setCreatedBy(UserContext.username());
                p.setCreatedAt(LocalDateTime.now());
                rows.add(p);
            }
        }
        payments.saveAll(rows);
        for (int no = 1; no <= 5; no++) {
            HostedChitMonth month = schedule.get(no - 1);
            BigDecimal value = c.getBaseValue().add(c.getMonthlyIncrement().multiply(BigDecimal.valueOf(no - 1L)));
            month.setWinnerMemberId(winners.get(no - 1).getId());
            month.setDrawMethod(random.nextBoolean() ? "Random draw" : "Picked");
            month.setPayoutAmount(value.subtract(c.getCommission()));
            month.setCommissionAmount(c.getCommission());
            LocalDate paidOut = dueDate(c, no).plusDays(5);
            month.setPayoutDate(paidOut.isAfter(LocalDate.now()) ? LocalDate.now() : paidOut);
            month.setPayoutMode(modes[random.nextInt(modes.length)]);
        }
        months.saveAll(schedule.subList(0, 5));
        activity.record("ADDED", AREA, "Loaded the demo chit · " + c.getName());
        return detail(c.getId());
    }

    @Transactional
    public int clearDemo() {
        List<HostedChit> demo = chits.findByTenantId(UserContext.tenantId()).stream()
                .filter(c -> Boolean.TRUE.equals(c.getDemo())).toList();
        demo.forEach(this::removeChit);
        if (!demo.isEmpty()) {
            activity.record("DELETED", AREA, "Cleared the demo chit");
        }
        return demo.size();
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

    private static void requireMonthNo(HostedChit c, Integer monthNo) {
        if (monthNo == null || monthNo < 1 || monthNo > c.getMonths()) {
            throw new BusinessException("Month must be between 1 and " + c.getMonths());
        }
    }

    private boolean structureLocked(HostedChit c) {
        return !payments.findByChitId(c.getId()).isEmpty()
                || months.findByChitId(c.getId()).stream().anyMatch(m -> m.getWinnerMemberId() != null);
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

    /** The income category the organiser's commission goes to (created on first use). */
    private Category commissionCategory() {
        return categoryRepository.findByName(UserContext.tenantId(), CategoryKind.INCOME, COMMISSION_CATEGORY)
                .orElseGet(() -> categoryService.require(categoryService.create(new CategoryRequest(CategoryKind.INCOME,
                        COMMISSION_CATEGORY, null, "Commission earned running chits as the organiser", true, null)).id()));
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

        HostedChitMonth month(int monthNo) {
            return monthList.stream().filter(m -> m.getMonthNo() == monthNo).findFirst()
                    .orElseThrow(() -> new BusinessException("Month must be between 1 and " + c.getMonths()));
        }

        BigDecimal chitValue(int monthNo) {
            return c.getBaseValue().add(c.getMonthlyIncrement().multiply(BigDecimal.valueOf(monthNo - 1L)));
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
                BigDecimal rest = c.getInstallment().subtract(paid(memberId, no));
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
                    BigDecimal rest = c.getInstallment().subtract(paid(m.getId(), no));
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
            boolean locked = !paymentList.isEmpty() || !won.isEmpty();
            return new ChitView(c.getId(), c.getName(), c.getStartMonth(), c.getDueDay(), c.getMemberCount(), c.getMonths(),
                    c.getInstallment(), c.getBaseValue(), c.getMonthlyIncrement(), c.getCommission(),
                    Boolean.TRUE.equals(c.getPostToBooks()), c.getAccountId(), accountName, c.getStatus(),
                    Boolean.TRUE.equals(c.getDemo()), c.getNotes(), shown, completedMonths, chitValue(shown),
                    collected(shown), c.getInstallment().multiply(BigDecimal.valueOf(memberList.size())),
                    (int) memberList.stream().filter(m -> paid(m.getId(), shown).compareTo(c.getInstallment()) >= 0).count(),
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

            List<MemberView> memberViews = memberList.stream().map(m -> new MemberView(m.getId(), m.getSlot(), m.getName(), m.getPhone(),
                    wonMonth(m.getId()),
                    paid.getOrDefault(m.getId(), Map.of()).values().stream().reduce(Money.ZERO, BigDecimal::add),
                    dues(m.getId()), m.getVersion())).toList();

            BigDecimal expected = c.getInstallment().multiply(BigDecimal.valueOf(memberList.size()));
            List<MonthView> schedule = monthList.stream().map(m -> {
                int no = m.getMonthNo();
                BigDecimal value = chitValue(no);
                boolean done = m.getPayoutDate() != null;
                BigDecimal commission = done ? Money.nz(m.getCommissionAmount()) : c.getCommission();
                BigDecimal payout = done ? Money.nz(m.getPayoutAmount()) : value.subtract(c.getCommission());
                int paidCount = (int) memberList.stream().filter(x -> paid(x.getId(), no).compareTo(c.getInstallment()) >= 0).count();
                String status = done ? "COMPLETED" : no == currentMonth ? "ONGOING" : "UPCOMING";
                return new MonthView(m.getId(), no, dueDate(c, no), c.getInstallment(), value, payout, commission,
                        m.getWinnerMemberId(), names.get(m.getWinnerMemberId()), m.getDrawMethod(), status, due(no),
                        collected(no), expected, paidCount, m.getPayoutDate(), m.getPayoutMode(),
                        entryNos.get(m.getPayoutEntryId()), m.getVersion());
            }).toList();

            List<PaymentView> paymentViews = paymentList.stream().map(p -> new PaymentView(p.getId(), p.getMemberId(),
                    names.get(p.getMemberId()), p.getMonthNo(), p.getAmount(), p.getPaidDate(), p.getMode(), p.getNote(),
                    entryNos.get(p.getJournalEntryId()), p.getCreatedBy(), p.getCreatedAt(), p.getVersion())).toList();

            // the ledger: every collection, payout and commission by date, with what is held after each
            record Line(LocalDate date, int order, String kind, int monthNo, String party, String mode, BigDecimal in, BigDecimal out,
                        String entryNo, String note, Long paymentId) {
            }
            List<Line> lines = new ArrayList<>();
            paymentList.forEach(p -> lines.add(new Line(p.getPaidDate(), 0, "COLLECTION", p.getMonthNo(), names.get(p.getMemberId()),
                    p.getMode(), p.getAmount(), Money.ZERO, entryNos.get(p.getJournalEntryId()), p.getNote(), p.getId())));
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
            return new Detail(view(), memberViews, schedule, paymentViews, ledgerRows);
        }
    }
}
