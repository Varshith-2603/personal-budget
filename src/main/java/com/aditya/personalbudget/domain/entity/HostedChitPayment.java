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

    @Positive
    @Column(nullable = false)
    private BigDecimal amount;

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
