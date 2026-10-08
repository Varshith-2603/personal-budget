package com.aditya.personalbudget.domain.entity;

import com.aditya.personalbudget.domain.TenantOwned;
import com.aditya.personalbudget.storage.References;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import jakarta.persistence.Version;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.PositiveOrZero;
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

import java.math.BigDecimal;
import java.time.LocalDate;

/**
 * One month of a {@link HostedChit}: its winner and, once paid, the payout. A month whose payout is done is
 * locked (its winner and payments stay as they are until the payout is undone).
 * Table file: {@code data/hosted_chit_months.tbl}
 */
@Entity
@Table(name = "hosted_chit_months", uniqueConstraints = @UniqueConstraint(columnNames = {"chitId", "monthNo"}))
@Getter
@Setter
@NoArgsConstructor
public class HostedChitMonth implements TenantOwned {

    @Id
    @GeneratedValue
    private Long id;

    @References(Tenant.class)
    @Column(nullable = false)
    private Long tenantId;

    @References(HostedChit.class)
    @Column(nullable = false)
    private Long chitId;

    @Positive
    @Column(nullable = false)
    private Integer monthNo;

    @References(HostedChitMember.class)
    private Long winnerMemberId;

    /** "Picked" or "Random draw". */
    @Column(length = 20)
    private String drawMethod;

    /** Paid to the winner (chit value - commission) once the payout is done. */
    @PositiveOrZero
    private BigDecimal payoutAmount;

    @PositiveOrZero
    private BigDecimal commissionAmount;

    private LocalDate payoutDate;

    /** Cash, UPI or Bank. */
    @Column(length = 10)
    private String payoutMode;

    @References(JournalEntry.class)
    private Long payoutEntryId;

    @References(JournalEntry.class)
    private Long commissionEntryId;

    @Version
    private Long version;
}
