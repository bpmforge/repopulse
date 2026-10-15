package com.example.orders;

import java.util.List;
import java.util.logging.Level;
import java.util.logging.Logger;

// Near-misses: the same jobs as the triggering fixture, done in ways none of
// the anti-slop Java rules should flag.
public class OrderService {
    private static final Logger LOG = Logger.getLogger(OrderService.class.getName());
    private final OrderRepository repository;

    public OrderService(OrderRepository repository) {
        this.repository = repository;
    }

    public void archive(long id) {
        try {
            repository.archive(id);
        } catch (IllegalStateException ignored) {
            // Already archived by a concurrent request; archiving is idempotent.
        }
    }

    public void close(AutoCloseable c) {
        try {
            c.close();
        } catch (Exception expected) {
        }
    }

    public void sleepALittle() {
        try {
            Thread.sleep(10);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    public int parsePort(String raw) {
        // A specific exception with a documented default is the parse idiom.
        try {
            return Integer.parseInt(raw);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    public Order find(long id) {
        try {
            return repository.find(id);
        } catch (RuntimeException e) {
            LOG.log(Level.WARNING, "order lookup failed", e);
            throw e;
        }
    }

    public int importAll(List<String> rows) {
        int imported = 0;
        int skipped = 0;
        for (String row : rows) {
            try {
                repository.save(Order.parse(row));
                imported++;
            } catch (IllegalArgumentException e) {
                skipped++;
                LOG.fine("skipping malformed row: " + e.getMessage());
            }
        }
        LOG.info("skipped " + skipped);
        return imported;
    }

    public List<Order> view() {
        // An immutable view refusing mutation is a contract, not a stub.
        throw new UnsupportedOperationException();
    }

    public void remove(Order o) {
        throw new UnsupportedOperationException("orders are immutable once placed");
    }

    public int total(List<Order> orders) {
        int sum = 0;
        // Refunds are negative amounts, so this is a net total, not gross.
        for (Order o : orders) {
            sum += o.amount();
        }
        // set by the scheduler before this runs; see Scheduler#prime
        return sum;
    }
}
