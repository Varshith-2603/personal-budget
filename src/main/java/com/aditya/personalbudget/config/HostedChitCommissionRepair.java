package com.aditya.personalbudget.config;

import com.aditya.personalbudget.domain.entity.Tenant;
import com.aditya.personalbudget.domain.type.Feature;
import com.aditya.personalbudget.domain.type.UserRole;
import com.aditya.personalbudget.repository.TenantRepository;
import com.aditya.personalbudget.security.CurrentUser;
import com.aditya.personalbudget.security.UserContext;
import com.aditya.personalbudget.service.HostedChitService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * At startup, splits hosted chit commission entries posted as one four-line voucher (income plus the move to the
 * commission account, which the journal showed as twice the amount) into the income entry and a transfer. Entries
 * already split are left alone, so it does nothing after the first run.
 */
@Component
@Order(25)
public class HostedChitCommissionRepair implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(HostedChitCommissionRepair.class);

    private final TenantRepository tenants;
    private final HostedChitService service;

    public HostedChitCommissionRepair(TenantRepository tenants, HostedChitService service) {
        this.tenants = tenants;
        this.service = service;
    }

    @Override
    public void run(ApplicationArguments args) {
        for (Tenant tenant : tenants.findAll()) {
            UserContext.set(new CurrentUser(null, "system", "Commission repair", UserRole.ADMIN,
                    tenant.getId(), tenant.getCode(), tenant.getName(), tenant.getCurrency(), Feature.all(), false));
            try {
                int repaired = service.repairCommissionEntries();
                if (repaired > 0) {
                    log.info("Tenant {}: split {} hosted chit commission entr{} into income and a transfer", tenant.getCode(), repaired, repaired == 1 ? "y" : "ies");
                }
            } catch (RuntimeException e) {
                log.warn("Tenant {}: could not repair hosted chit commission entries: {}", tenant.getCode(), e.getMessage());
            } finally {
                UserContext.clear();
            }
        }
    }
}
