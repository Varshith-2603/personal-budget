package com.aditya.personalbudget.web;

import com.aditya.personalbudget.security.Permission;
import com.aditya.personalbudget.security.RequiresPermission;
import com.aditya.personalbudget.service.HostedChitService;
import com.aditya.personalbudget.service.HostedChitService.ChitRequest;
import com.aditya.personalbudget.service.HostedChitService.ChitView;
import com.aditya.personalbudget.service.HostedChitService.CollectAllRequest;
import com.aditya.personalbudget.service.HostedChitService.Detail;
import com.aditya.personalbudget.service.HostedChitService.MemberInput;
import com.aditya.personalbudget.service.HostedChitService.PaymentRequest;
import com.aditya.personalbudget.service.HostedChitService.PayoutRequest;
import com.aditya.personalbudget.service.HostedChitService.Summary;
import com.aditya.personalbudget.service.HostedChitService.WinnerRequest;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/** Host a Chit: chits the user runs as the organiser (see {@link HostedChitService}). */
@RestController
@RequestMapping("/api/hosted-chits")
public class HostedChitController {

    private final HostedChitService service;

    public HostedChitController(HostedChitService service) {
        this.service = service;
    }

    @GetMapping
    @RequiresPermission(Permission.VIEW)
    public List<ChitView> list() {
        return service.list();
    }

    /** Dues still to collect across the running hosted chits (dashboard). */
    @GetMapping("/summary")
    @RequiresPermission(Permission.VIEW)
    public Summary summary() {
        return service.summary();
    }

    @GetMapping("/{id}")
    @RequiresPermission(Permission.VIEW)
    public Detail detail(@PathVariable Long id) {
        return service.detail(id);
    }

    @PostMapping
    @RequiresPermission(Permission.MANAGE_CHITS)
    public Detail create(@Valid @RequestBody ChitRequest request) {
        return service.create(request);
    }

    @PutMapping("/{id}")
    @RequiresPermission(Permission.MANAGE_CHITS)
    public Detail update(@PathVariable Long id, @Valid @RequestBody ChitRequest request) {
        return service.update(id, request);
    }

    @DeleteMapping("/{id}")
    @RequiresPermission(Permission.MANAGE_CHITS)
    public ResponseEntity<Void> delete(@PathVariable Long id) {
        service.delete(id);
        return ResponseEntity.noContent().build();
    }

    @PutMapping("/{id}/members/{memberId}")
    @RequiresPermission(Permission.MANAGE_CHITS)
    public Detail updateMember(@PathVariable Long id, @PathVariable Long memberId, @Valid @RequestBody MemberInput request) {
        return service.updateMember(id, memberId, request);
    }

    // ---------------------------------------------------------------- collections

    @PostMapping("/{id}/payments")
    @RequiresPermission(Permission.MANAGE_CHITS)
    public Detail addPayment(@PathVariable Long id, @Valid @RequestBody PaymentRequest request) {
        return service.addPayment(id, request);
    }

    @PutMapping("/{id}/payments/{paymentId}")
    @RequiresPermission(Permission.MANAGE_CHITS)
    public Detail updatePayment(@PathVariable Long id, @PathVariable Long paymentId, @Valid @RequestBody PaymentRequest request) {
        return service.updatePayment(id, paymentId, request);
    }

    @DeleteMapping("/{id}/payments/{paymentId}")
    @RequiresPermission(Permission.MANAGE_CHITS)
    public Detail deletePayment(@PathVariable Long id, @PathVariable Long paymentId) {
        return service.deletePayment(id, paymentId);
    }

    @PostMapping("/{id}/months/{monthNo}/collect-all")
    @RequiresPermission(Permission.MANAGE_CHITS)
    public Detail collectAll(@PathVariable Long id, @PathVariable int monthNo, @RequestBody(required = false) CollectAllRequest request) {
        return service.collectAll(id, monthNo, request);
    }

    // ---------------------------------------------------------------- winner and payout

    @PostMapping("/{id}/months/{monthNo}/winner")
    @RequiresPermission(Permission.MANAGE_CHITS)
    public Detail setWinner(@PathVariable Long id, @PathVariable int monthNo, @Valid @RequestBody WinnerRequest request) {
        return service.setWinner(id, monthNo, request);
    }

    @DeleteMapping("/{id}/months/{monthNo}/winner")
    @RequiresPermission(Permission.MANAGE_CHITS)
    public Detail clearWinner(@PathVariable Long id, @PathVariable int monthNo) {
        return service.clearWinner(id, monthNo);
    }

    @PostMapping("/{id}/months/{monthNo}/payout")
    @RequiresPermission(Permission.MANAGE_CHITS)
    public Detail payout(@PathVariable Long id, @PathVariable int monthNo, @RequestBody PayoutRequest request) {
        return service.payout(id, monthNo, request);
    }

    @DeleteMapping("/{id}/months/{monthNo}/payout")
    @RequiresPermission(Permission.MANAGE_CHITS)
    public Detail undoPayout(@PathVariable Long id, @PathVariable int monthNo) {
        return service.undoPayout(id, monthNo);
    }

    // ---------------------------------------------------------------- demo data

    @PostMapping("/demo")
    @RequiresPermission(Permission.MANAGE_CHITS)
    public Detail loadDemo() {
        return service.loadDemo();
    }

    @DeleteMapping("/demo")
    @RequiresPermission(Permission.MANAGE_CHITS)
    public Map<String, Integer> clearDemo() {
        return Map.of("removed", service.clearDemo());
    }
}
