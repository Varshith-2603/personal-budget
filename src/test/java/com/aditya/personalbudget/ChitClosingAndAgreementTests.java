package com.aditya.personalbudget;

import com.aditya.personalbudget.domain.entity.AppUser;
import com.aditya.personalbudget.domain.entity.JournalLine;
import com.aditya.personalbudget.domain.entity.Tenant;
import com.aditya.personalbudget.domain.type.AccountType;
import com.aditya.personalbudget.domain.type.ClaimKind;
import com.aditya.personalbudget.domain.type.Feature;
import com.aditya.personalbudget.domain.type.UserRole;
import com.aditya.personalbudget.dto.AccountDtos.AccountRequest;
import com.aditya.personalbudget.dto.ClaimDtos.ClaimRequest;
import com.aditya.personalbudget.exception.BusinessException;
import com.aditya.personalbudget.repository.AppUserRepository;
import com.aditya.personalbudget.repository.JournalLineRepository;
import com.aditya.personalbudget.repository.TenantRepository;
import com.aditya.personalbudget.security.CurrentUser;
import com.aditya.personalbudget.security.UserContext;
import com.aditya.personalbudget.service.AccountService;
import com.aditya.personalbudget.service.ClaimAgreementService;
import com.aditya.personalbudget.service.ClaimAgreementService.AcceptRequest;
import com.aditya.personalbudget.service.ClaimAgreementService.AgreementRequest;
import com.aditya.personalbudget.service.ClaimAgreementService.OpenRequest;
import com.aditya.personalbudget.service.ClaimAgreementService.PublicAgreement;
import com.aditya.personalbudget.service.ClaimService;
import com.aditya.personalbudget.service.HostedChitBookService.ChitMoney;
import com.aditya.personalbudget.service.HostedChitBookService.LegInput;
import com.aditya.personalbudget.service.HostedChitBookService.Spot;
import com.aditya.personalbudget.service.HostedChitService;
import com.aditya.personalbudget.service.HostedChitService.ChitRequest;
import com.aditya.personalbudget.service.HostedChitService.CloseRequest;
import com.aditya.personalbudget.service.HostedChitService.Detail;
import com.aditya.personalbudget.service.HostedChitService.MemberInput;
import com.aditya.personalbudget.service.HostedChitService.PaymentRequest;
import com.aditya.personalbudget.service.HostedChitService.PayoutRequest;
import com.aditya.personalbudget.service.HostedChitService.WinnerRequest;
import com.aditya.personalbudget.service.Kyc;
import com.aditya.personalbudget.service.ReportService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Host a Chit: closing a finished chit, payments locked once paid out, changing a payout, the commission kept where
 * members paid it, the commission account running short; and the loan agreement link of money lent.
 */
@SpringBootTest
class ChitClosingAndAgreementTests {

    @DynamicPropertySource
    static void dataDirectory(DynamicPropertyRegistry registry) throws Exception {
        Path dir = Files.createTempDirectory("pb-chitclose-test-");
        registry.add("budget.data-dir", dir::toString);
        registry.add("budget.seed.demo-data", () -> "false");
    }

    @Autowired TenantRepository tenants;
    @Autowired AppUserRepository users;
    @Autowired JournalLineRepository lines;
    @Autowired AccountService accounts;
    @Autowired HostedChitService chits;
    @Autowired ReportService reports;
    @Autowired ClaimService claims;
    @Autowired ClaimAgreementService loanAgreements;

    @BeforeEach
    void signIn() {
        AppUser admin = users.findByUsername("admin").orElseThrow();
        Tenant tenant = tenants.findById(admin.getTenantId()).orElseThrow();
        UserContext.set(new CurrentUser(admin.getId(), "admin", "Admin", UserRole.ADMIN, tenant.getId(), tenant.getCode(), tenant.getName(),
                tenant.getCurrency(), Feature.all(), false, null, false));
    }

    @AfterEach
    void signOut() {
        UserContext.clear();
    }

    @Test
    void aFinishedChitClosesAndNothingChangesUntilItIsReopened() {
        Detail d = chits.create(chit("Closing " + System.nanoTime()));
        Long chitId = d.chit().id();
        List<Long> ids = d.members().stream().map(HostedChitService.MemberView::id).toList();
        assertThatThrownBy(() -> chits.close(chitId, new CloseRequest(null, true)))
                .isInstanceOf(BusinessException.class).hasMessageContaining("3 months to pay out");

        for (int month = 1; month <= 3; month++) {
            for (Long m : ids) pay(chitId, m, month);
            chits.setWinner(chitId, month, new WinnerRequest(ids.get(month - 1), false, null));
            d = chits.payout(chitId, month, payout(List.of()));
        }
        assertThat(d.chit().status()).isEqualTo("COMPLETED");
        d = chits.close(chitId, new CloseRequest("All settled", false));
        assertThat(d.chit().closed()).isTrue();
        assertThat(d.chit().closeNote()).isEqualTo("All settled");
        assertThat(d.payments()).allMatch(HostedChitService.PaymentView::locked);

        Long paymentId = d.payments().getFirst().id();
        assertThatThrownBy(() -> chits.deletePayment(chitId, paymentId)).isInstanceOf(BusinessException.class).hasMessageContaining("closed");
        assertThatThrownBy(() -> chits.undoPayout(chitId, 3)).isInstanceOf(BusinessException.class).hasMessageContaining("Re-open");
        assertThatThrownBy(() -> chits.addPayment(chitId, new PaymentRequest(ids.get(0), 1, bd(10), null, null, null, LocalDate.now(), "UPI",
                null, true, null, null, null))).isInstanceOf(BusinessException.class);

        d = chits.reopen(chitId);
        assertThat(d.chit().closed()).isFalse();
        assertThat(d.chit().status()).isEqualTo("COMPLETED");
        d = chits.undoPayout(chitId, 3);
        assertThat(d.chit().status()).isEqualTo("ACTIVE");
    }

    @Test
    void paidOutPaymentsAreLockedAndThePayoutItselfCanBeChanged() {
        Long hdfc = bank("HDFC Close " + System.nanoTime());
        Detail d = chits.create(chit("Edit payout " + System.nanoTime()));
        Long chitId = d.chit().id();
        Long collections = d.chit().accountId();
        List<Long> ids = d.members().stream().map(HostedChitService.MemberView::id).toList();
        pay(chitId, ids.get(0), 1, hdfc);
        pay(chitId, ids.get(1), 1);
        pay(chitId, ids.get(2), 1);
        chits.setWinner(chitId, 1, new WinnerRequest(ids.get(0), false, null));
        d = chits.payout(chitId, 1, payout(List.of(new LegInput(collections, bd(28500), "Bank", "U1"))));
        assertThat(d.payments()).allMatch(HostedChitService.PaymentView::locked);
        Long first = d.payments().getFirst().id();
        assertThatThrownBy(() -> chits.updatePayment(chitId, first, new PaymentRequest(ids.get(0), 1, bd(9000), null, null, null,
                LocalDate.now(), "UPI", null, false, null, null, null))).isInstanceOf(BusinessException.class).hasMessageContaining("Undo that payout");

        // a late payment for the month, recorded after the payout, stays editable
        d = chits.addPayment(chitId, new PaymentRequest(ids.get(1), 1, bd(100), null, null, null, LocalDate.now(), "UPI", null, true, null, null, null));
        assertThat(d.payments().getLast().locked()).isFalse();

        // the payout moves to two accounts: the HDFC money and the collections
        d = chits.updatePayout(chitId, 1, new PayoutRequest(LocalDate.now(), "Bank", null, true, false, null, null,
                List.of(new LegInput(hdfc, bd(10000), "UPI", "H1"), new LegInput(collections, bd(18500), "Bank", "C1")), "SBI 9", null));
        var month = d.schedule().getFirst();
        assertThat(month.legs()).hasSize(2);
        assertThat(month.payoutTo()).isEqualTo("SBI 9");
        List<JournalLine> payoutLines = lines.findByJournalEntryId(month.payoutEntryId());
        assertThat(payoutLines).hasSize(3);
        assertThat(spot(d.money(), hdfc)).isEqualByComparingTo("0");
        assertThat(reports.balanceSheet(LocalDate.now(), null).balanced()).isTrue();

        // once the winner accepts the agreement, the payout is final
        chits.createAgreement(chitId, 1, new HostedChitService.AgreementRequest(null, null, null));
        d = chits.detail(chitId);
        Long agreementId = d.agreements().getFirst().id();
        chits.markAgreementSigned(chitId, agreementId, "Ravi");
        assertThatThrownBy(() -> chits.updatePayout(chitId, 1, payout(List.of(new LegInput(collections, bd(28500), "Bank", null)))))
                .isInstanceOf(BusinessException.class).hasMessageContaining("agreement");
    }

    @Test
    void theCommissionStaysInTheAccountMembersPaidInto() {
        Long sbi = bank("SBI Commission " + System.nanoTime());
        ChitRequest base = chit("Kept commission " + System.nanoTime());
        // the commission account is a personal bank account that members also pay into
        ChitRequest r = new ChitRequest(base.name(), "FIXED", base.startMonth(), 5, 3, 3, bd(10000), bd(30000), BigDecimal.ZERO, bd(1500),
                "NONE", null, null, null, 0, null, null, true, null, true, sbi, false, null, null, false, null, base.members(), null, null, null);
        Detail d = chits.create(r);
        Long chitId = d.chit().id();
        Long collections = d.chit().accountId();
        assertThat(d.chit().commissionAccountId()).isEqualTo(sbi);
        List<Long> ids = d.members().stream().map(HostedChitService.MemberView::id).toList();
        pay(chitId, ids.get(0), 1, sbi);
        pay(chitId, ids.get(1), 1);
        pay(chitId, ids.get(2), 1);
        chits.setWinner(chitId, 1, new WinnerRequest(ids.get(1), false, null));
        // 28,500 to the winner: 8,500 of the SBI money and 20,000 of the collections; the 1,500 commission stays in SBI
        d = chits.payout(chitId, 1, new PayoutRequest(LocalDate.now(), "Bank", null, true, false, null, null,
                List.of(new LegInput(sbi, bd(8500), "UPI", null), new LegInput(collections, bd(20000), "Bank", null)), null, sbi));
        var month = d.schedule().getFirst();
        assertThat(month.commissionRetained()).isTrue();
        assertThat(spot(d.money(), sbi)).isEqualByComparingTo("0");          // no chit money left in SBI: the rest is mine
        assertThat(spot(d.money(), collections)).isEqualByComparingTo("0");
        assertThat(d.money().owedToMembers()).isEqualByComparingTo("0");
        assertThat(accounts.list().stream().filter(a -> a.id().equals(sbi)).findFirst().orElseThrow().balance()).isEqualByComparingTo("1500");
        assertThat(reports.balanceSheet(LocalDate.now(), null).balanced()).isTrue();

        // more paid out of SBI than leaves room for the commission: refused with what to do
        chits.undoPayout(chitId, 1);
        assertThatThrownBy(() -> chits.payout(chitId, 1, new PayoutRequest(LocalDate.now(), "Bank", null, true, false, null, null,
                List.of(new LegInput(sbi, bd(10000), "UPI", null), new LegInput(collections, bd(18500), "Bank", null)), null, sbi)))
                .isInstanceOf(BusinessException.class).hasMessageContaining("less than your");
    }

    @Test
    void aShortCommissionAccountIsToldWhereTheRestShouldComeFrom() {
        ChitRequest planned = new ChitRequest("Short planned " + System.nanoTime(), "PLANNED", LocalDate.now().minusMonths(2).withDayOfMonth(1), 5, 3, 3,
                bd(10000), bd(30000), BigDecimal.ZERO, BigDecimal.ZERO, "NONE", null, null, null, 0, null, null, true, null, true, null, true,
                null, null, false, null, List.of(new MemberInput("Ravi", null, null, null), new MemberInput("Lakshmi", null, null, null),
                new MemberInput("Suresh", null, null, null)), null, BigDecimal.ZERO,
                List.of(new HostedChitService.PlanMonth(1, null, bd(29000)), new HostedChitService.PlanMonth(2, null, bd(30000)),
                        new HostedChitService.PlanMonth(3, null, bd(33000))));
        Detail d = chits.create(planned);
        Long chitId = d.chit().id();
        Long commission = d.chit().commissionAccountId();
        Long collections = d.chit().accountId();
        List<Long> ids = d.members().stream().map(HostedChitService.MemberView::id).toList();
        for (int month = 1; month <= 2; month++) {
            for (Long m : ids) pay(chitId, m, month);
            chits.setWinner(chitId, month, new WinnerRequest(ids.get(month - 1), false, null));
            chits.payout(chitId, month, payout(List.of()));
        }
        for (Long m : ids) pay(chitId, m, 3);
        chits.setWinner(chitId, 3, new WinnerRequest(ids.get(2), false, null));
        // only 1,000 of commission was kept; month 3 needs 3,000 above its collections
        assertThatThrownBy(() -> chits.payout(chitId, 3, payout(List.of(new LegInput(collections, bd(30000), "Bank", null),
                new LegInput(commission, bd(3000), "Bank", null)))))
                .isInstanceOf(BusinessException.class).hasMessageContaining("holds only").hasMessageContaining("2,000");
        // without parts, the commission account gives what it has and the collections the rest
        d = chits.payout(chitId, 3, payout(List.of()));
        assertThat(d.schedule().get(2).legs()).anyMatch(l -> l.accountId().equals(commission) && l.amount().compareTo(bd(1000)) == 0);
    }

    @Test
    void aBorrowerOpensTheLoanAgreementWithTheirNumberAndAcceptsIt() {
        Long bank = bank("Lend bank " + System.nanoTime());
        Long claimId = claims.create(new ClaimRequest(ClaimKind.LENT, "Kiran " + System.nanoTime(), "Hand loan", bd(50000),
                LocalDate.now().minusDays(3), LocalDate.now().plusMonths(6), BigDecimal.valueOf(12), null, bank, null, null, null, null, null,
                null, null)).id();
        var view = loanAgreements.save(claimId, new AgreementRequest(null, null, null, "9876543210", "Hyderabad", "Hyderabad",
                bd(100), null, "Witness One", null, null, true, false, false, null));
        assertThat(view.terms()).contains("50,000").contains("12% a year");
        String token = loanAgreements.link(claimId, new ClaimAgreementService.LinkRequest(48)).token();

        PublicAgreement gate = loanAgreements.open(token, null);
        assertThat(gate.step()).isEqualTo("VERIFY");
        assertThat(gate.terms()).isNull();
        assertThat(gate.phoneHint()).isEqualTo("••••••3210");
        PublicAgreement wrong = loanAgreements.open(token, new OpenRequest("9123456780"));
        assertThat(wrong.step()).isEqualTo("VERIFY");
        assertThat(wrong.attemptsLeft()).isEqualTo(4);
        PublicAgreement open = loanAgreements.open(token, new OpenRequest("98765 43210"));
        assertThat(open.step()).isEqualTo("OPEN");
        assertThat(open.amount()).isEqualByComparingTo("50000");

        String sign = "M10 10 L200 120 L400 60 L600 200";
        assertThatThrownBy(() -> loanAgreements.accept(token, new AcceptRequest("9876543210", "Kiran", true, "234123412346", sign, null, "{}"), "1.2.3.4", "UA"))
                .isInstanceOf(BusinessException.class).hasMessageContaining("Aadhaar card");
        byte[] png = {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10, 0, 0, 0, 0};
        loanAgreements.addKyc(token, "9876543210", "AADHAAR_FRONT", "aadhaar.png", png);
        assertThatThrownBy(() -> loanAgreements.accept(token, new AcceptRequest("9876543210", "Kiran", true, "234123412345", sign, null, "{}"), "1.2.3.4", "UA"))
                .isInstanceOf(BusinessException.class).hasMessageContaining("check digit");
        PublicAgreement done = loanAgreements.accept(token, new AcceptRequest("9876543210", "Kiran Kumar", true, "234123412346", sign, null, "{}"), "1.2.3.4", "UA");
        assertThat(done.step()).isEqualTo("DONE");
        assertThat(done.aadhaarLast4()).isEqualTo("2346");
        assertThat(done.evidencePayload()).contains("\"agreementNo\"").doesNotContain("234123412346");
        assertThat(done.digitalSignature()).isNotBlank();
        assertThat(claims.get(claimId).agreementStatus()).isEqualTo("ACCEPTED");
        assertThatThrownBy(() -> claims.delete(claimId)).isInstanceOf(BusinessException.class).hasMessageContaining("legal record");
    }

    @Test
    void aadhaarAndPanAreCheckedAndMasked() {
        assertThat(Kyc.aadhaar("2341 2341 2346")).isEqualTo("234123412346");
        assertThatThrownBy(() -> Kyc.aadhaar("123412341234")).isInstanceOf(BusinessException.class);
        assertThat(Kyc.maskPan(Kyc.pan("abcpe1234f"))).isEqualTo("ABCPE••••F");
        assertThatThrownBy(() -> Kyc.pan("ABCDE12345")).isInstanceOf(BusinessException.class);
    }

    private Detail pay(Long chitId, Long memberId, int monthNo) {
        return pay(chitId, memberId, monthNo, null);
    }

    private Detail pay(Long chitId, Long memberId, int monthNo, Long into) {
        return chits.addPayment(chitId, new PaymentRequest(memberId, monthNo, bd(10000), null, null, "R" + memberId + monthNo,
                LocalDate.now(), "UPI", null, false, null, into, null));
    }

    private static PayoutRequest payout(List<LegInput> legs) {
        return new PayoutRequest(LocalDate.now(), "Bank", null, true, false, null, null, legs, "SBI 1234", null);
    }

    private static BigDecimal spot(ChitMoney m, Long accountId) {
        return m.spots().stream().filter(s -> s.accountId().equals(accountId)).map(Spot::amount).findFirst().orElse(BigDecimal.ZERO);
    }

    private Long bank(String name) {
        return accounts.create(new AccountRequest(null, name, AccountType.BANK, "Bank", null, null, null, null, null, null, null,
                null, true, null)).id();
    }

    private static ChitRequest chit(String name) {
        return new ChitRequest(name, "FIXED", LocalDate.now().minusMonths(2).withDayOfMonth(1), 5, 3, 3, bd(10000), bd(30000),
                BigDecimal.ZERO, bd(1500), "NONE", null, null, null, 0, null, null, true, null, true, null, true, null, null, false,
                null, List.of(new MemberInput("Ravi", null, null, "SBI 1234"), new MemberInput("Lakshmi", null, null, null),
                new MemberInput("Suresh", null, null, null)), null, null, null);
    }

    private static BigDecimal bd(long v) {
        return BigDecimal.valueOf(v);
    }
}
