package com.aditya.personalbudget.domain.entity;

import com.aditya.personalbudget.domain.TenantOwned;
import com.aditya.personalbudget.storage.References;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.PositiveOrZero;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;

/**
 * Money a member paid towards one month's installment of a {@link HostedChit}. A month can be paid in parts.
 * Table file: {@code data/hosted_chit_payments.tbl}
 */
@Entity
@Table(name = "hosted_chit_payments")
@Getter
@Setter
@NoArgsConstructor
public class HostedChitPayment implements TenantOwned {

    @Id
    @GeneratedValue
    private Long id;

    @References(Tenant.class)
    @Column(nullable = false)
    private Long tenantId;

    @References(HostedChit.class)
    @Column(nullable = false)
    private Long chitId;

    @References(HostedChitMember.class)
    @Column(nullable = false)
    private Long memberId;

    @Positive
    @Column(nullable = false)
    private Integer monthNo;

    /** Towards the month's installment (can be 0 when only late interest is paid). */
    @PositiveOrZero
    @Column(nullable = false)
    private BigDecimal amount;

    /** Late payment interest collected with this payment (the organiser's income). */
    @PositiveOrZero
    private BigDecimal lateFee;

    /** Late payment interest let off with this payment. */
    @PositiveOrZero
    private BigDecimal lateFeeWaived;

    /** UPI reference, cheque or bank transfer number. */
    @Column(length = 60)
    private String reference;

    /** RC-000123: printed on the receipt. */
    @Column(length = 20)
    private String receiptNo;

    @Column(nullable = false)
    private LocalDate paidDate;

    /** Cash, UPI or Bank. */
    @Column(nullable = false, length = 10)
    private String mode;

    @Column(length = 255)
    private String note;

    @References(JournalEntry.class)
    private Long journalEntryId;

    @Column(nullable = false, length = 50)
    private String createdBy;

    @Column(nullable = false)
    private LocalDateTime createdAt;

    @Version
    private Long version;
}
