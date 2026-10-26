package com.example.reports;

import com.google.common.collect.Lists;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

// Near-misses from the W21-20 hand-check: each shape below was marked wrong
// on real code, and no performance rule may fire on it.
public class Misfires {
    private final EntityDao entityDao;
    private final RelationRepository relationRepository;

    public Misfires(EntityDao entityDao, RelationRepository relationRepository) {
        this.entityDao = entityDao;
        this.relationRepository = relationRepository;
    }

    // Keyset pagination: each pass fetches the page after the last one.
    public int sweep() {
        UUID last = null;
        int n = 0;
        while (true) {
            List<UUID> ids = entityDao.findIdsByIdOffset(last, 128);
            if (ids.isEmpty()) {
                return n;
            }
            n += ids.size();
            last = ids.get(ids.size() - 1);
        }
    }

    // One query per partition is the batched form.
    public List<Relation> relations(List<UUID> ids) {
        List<Relation> out = new ArrayList<>();
        for (List<UUID> batch : Lists.partition(ids, 500)) {
            out.addAll(relationRepository.findAllByFromIds(batch));
        }
        return out;
    }

    // A String declared inside the loop is fresh each time.
    public List<String> titles(List<Recipient> recipients) {
        List<String> out = new ArrayList<>();
        for (Recipient r : recipients) {
            String title = r.getTitle();
            title += " (" + r.getEmail() + ")";
            out.add(title);
        }
        return out;
    }
}
