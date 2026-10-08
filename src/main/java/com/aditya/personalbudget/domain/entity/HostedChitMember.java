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
import lombok.Getter;
import lombok.NoArgsConstructor;
import lombok.Setter;

/**
 * A member of a {@link HostedChit}. Which month they won is kept on {@link HostedChitMonth#getWinnerMemberId()}.
 * Table file: {@code data/hosted_chit_members.tbl}
 */
@Entity
@Table(name = "hosted_chit_members", uniqueConstraints = @UniqueConstraint(columnNames = {"chitId", "slot"}))
@Getter
@Setter
@NoArgsConstructor
public class HostedChitMember implements TenantOwned {

    @Id
    @GeneratedValue
    private Long id;

    @References(Tenant.class)
    @Column(nullable = false)
    private Long tenantId;

    @References(HostedChit.class)
    @Column(nullable = false)
    private Long chitId;

    /** Position in the member list (1..n). */
    @Positive
    @Column(nullable = false)
    private Integer slot;

    @Column(nullable = false, length = 100)
    private String name;

    @Column(length = 20)
    private String phone;

    @Version
    private Long version;
}
