package com.aditya.personalbudget.config;

import com.aditya.personalbudget.domain.entity.Tenant;
import com.aditya.personalbudget.domain.type.Feature;
import com.aditya.personalbudget.domain.type.UserRole;
import com.aditya.personalbudget.repository.TenantRepository;
import com.aditya.personalbudget.security.CurrentUser;
import com.aditya.personalbudget.security.UserContext;
import com.aditya.personalbudget.service.AppSettingsService;
import com.aditya.personalbudget.service.HostedChitService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * Adds the sample hosted chit ("Family Chit 2026") to the default household once (whether or not the rest of the
 * demo data is on), so the Host a Chit section is not empty on first use. An installation that already existed
 * before Host a Chit gets it at the next start; a new one gets it from {@link DataSeeder}. After that it is never added again by itself
 * (so "Clear demo data" sticks); "Load demo data" on the page brings it back.
 */
@Component
@Order(30)
public class HostedChitDemoSeeder implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(HostedChitDemoSeeder.class);

    private final TenantRepository tenants;
    private final HostedChitService hostedChits;
    private final AppSettingsService settings;
    private final BudgetProperties properties;

    public HostedChitDemoSeeder(TenantRepository tenants, HostedChitService hostedChits, AppSettingsService settings,
                                BudgetProperties properties) {
        this.tenants = tenants;
        this.hostedChits = hostedChits;
        this.settings = settings;
        this.properties = properties;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (settings.hostedChitDemoSeeded()) {
            return;
        }
        // first start: no household yet, DataSeeder (which runs last) creates it and seeds the chit itself
        tenants.findByCode(properties.seed().tenantCode()).ifPresent(this::seed);
    }

    /** Seeds the sample hosted chit for a household (as the system) and remembers that it was done. */
    public void seed(Tenant tenant) {
        UserContext.set(new CurrentUser(null, "system", "Demo data", UserRole.ADMIN, tenant.getId(), tenant.getCode(),
                tenant.getName(), tenant.getCurrency(), Feature.all(), false));
        try {
            if (!hostedChits.hasDemo()) {
                hostedChits.loadDemo();
                log.info("Added the sample hosted chit for tenant '{}'", tenant.getCode());
            }
            settings.markHostedChitDemoSeeded();
        } catch (RuntimeException e) {
            log.warn("Could not add the sample hosted chit", e);
        } finally {
            UserContext.clear();
        }
    }
}
