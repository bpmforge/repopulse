package com.example.orders;

import java.util.Collections;
import java.util.List;
import java.util.Optional;

// Every construct below is one the anti-slop Java rules must flag. Each
// expected finding is announced by a `ruleid:` comment on the line above it.
public class OrderService {
    private final OrderRepository repository;

    public OrderService(OrderRepository repository) {
        this.repository = repository;
    }

    public void archive(long id) {
        try {
            repository.archive(id);
            // ruleid: bpm-ch-java-empty-catch
        } catch (IllegalStateException e) {
        }
    }

    public void archiveLoudly(long id) {
        try {
            repository.archive(id);
            // ruleid: bpm-ch-java-empty-catch
        } catch (RuntimeException e) {
            e.printStackTrace();
        }
    }

    public List<Order> openOrders(String customer) {
        try {
            return repository.findOpen(customer);
            // ruleid: bpm-ch-java-silent-fallback-return
        } catch (Exception e) {
            return Collections.emptyList();
        }
    }

    public Order find(long id) {
        try {
            return repository.find(id);
            // ruleid: bpm-ch-java-silent-fallback-return
        } catch (Throwable t) {
            return null;
        }
    }

    public Optional<Order> maybe(long id) {
        try {
            return Optional.of(repository.find(id));
            // ruleid: bpm-ch-java-silent-fallback-return
        } catch (Exception e) {
            e.printStackTrace();
            return Optional.empty();
        }
    }

    public int importAll(List<String> rows) {
        int imported = 0;
        for (String row : rows) {
            try {
                repository.save(Order.parse(row));
                imported++;
                // ruleid: bpm-ch-java-try-catch-in-loop
            } catch (Exception e) {
                continue;
            }
        }
        return imported;
    }

    public void refund(long id) {
        // ruleid: bpm-ch-java-stub-as-feature
        throw new UnsupportedOperationException("Not implemented");
    }

    public void export(long id) {
        // ruleid: bpm-ch-java-stub-as-feature
        throw new RuntimeException("TODO: export orders");
    }

    public void reconcile() {
        // ruleid: bpm-ch-java-stub-as-feature
        throw new org.apache.commons.lang3.NotImplementedException("later");
    }

    public int total(List<Order> orders) {
        int sum = 0;
        // ruleid: bpm-ch-jvm-what-comment
        // loop through the orders
        for (Order o : orders) {
            // ruleid: bpm-ch-jvm-what-comment
            // increment the sum
            sum += o.amount();
        }
        // ruleid: bpm-ch-jvm-step-narration
        // Step 2: return the result
        return sum;
    }

    // ruleid: bpm-ch-jvm-prose-padding
    // It is important to note that this method is not thread safe.
    public void reset() {
        repository.clear();
    }
}
