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
 * A chit the user runs as the organiser (foreman): every month each member pays the installment and one member
 * (who has not won before) takes the pot. The pot grows by {@code monthlyIncrement} each month and the organiser
 * keeps {@code commission} from it:
 * <pre>
 *   chit value(m) = baseValue + (m - 1) * monthlyIncrement
 *   payout(m)     = chit value(m) - commission
 * </pre>
 * Unlike {@link Chit} (a chit the user is a member of), the money collected is not the user's: when
 * {@code postToBooks} is on it is held in the "Hosted Chit Funds" liability until it is paid out, and only the
 * commission is income. Table file: {@code data/hosted_chits.tbl}
 */
@Entity
@Table(name = "hosted_chits")
@Getter
@Setter
@NoArgsConstructor
public class HostedChit implements TenantOwned {

    public static final String ACTIVE = "ACTIVE";
    public static final String COMPLETED = "COMPLETED";

    @Id
    @GeneratedValue
    private Long id;

    @References(Tenant.class)
    @Column(nullable = false)
    private Long tenantId;

    @Column(nullable = false, length = 100)
    private String name;

    /** First day of the month the chit starts (month 1). */
    @Column(nullable = false)
    private LocalDate startMonth;

    /** Day of the month installments are due (1-28). */
    @Positive
    @Column(nullable = false)
    private Integer dueDay;

    @Positive
    @Column(nullable = false)
    private Integer memberCount;

    @Positive
    @Column(nullable = false)
    private Integer months;

    @Positive
    @Column(nullable = false)
    private BigDecimal installment;

    @Positive
    @Column(nullable = false)
    private BigDecimal baseValue;

    @PositiveOrZero
    @Column(nullable = false)
    private BigDecimal monthlyIncrement;

    @PositiveOrZero
    @Column(nullable = false)
    private BigDecimal commission;

    /** Post collections, payouts and commission to the books (journal, income, balance sheet). */
    private Boolean postToBooks;

    /** The cash / bank account collections go into and payouts come from (when posting). */
    @References(Account.class)
    private Long accountId;

    /** ACTIVE or COMPLETED. */
    @Column(nullable = false, length = 10)
    private String status;

    /** Sample data, removable with "Clear demo data". */
    private Boolean demo;

    @Column(length = 255)
    private String notes;

    @Column(nullable = false, length = 50)
    private String createdBy;

    @Column(nullable = false)
    private LocalDateTime createdAt;

    @Version
    private Long version;
}
