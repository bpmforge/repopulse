# Every construct below is one the Ruby anti-slop and logging rules must flag.
# Each expected finding is announced by a `ruleid:` comment on the line above.

class OrderService
  def archive(id)
    store.archive(id)
  # ruleid: bpm-ch-rb-empty-rescue
  rescue => e
  end

  def touch(id)
    begin
      store.touch(id)
    # ruleid: bpm-ch-rb-empty-rescue
    rescue Exception
    end
  end

  def recent
    store.recent
  # ruleid: bpm-ch-rb-silent-fallback
  rescue StandardError
    []
  end

  def price(order)
    # ruleid: bpm-ch-rb-rescue-nil-modifier
    order.line_items.sum(&:price) rescue nil
  end

  def refund(id)
    # ruleid: bpm-ch-rb-stub-as-feature
    raise "Not implemented"
  end

  def export
    # ruleid: bpm-ch-rb-stub-as-feature
    raise ArgumentError, "TODO: support CSV exports"
  end

  def total(orders)
    total = 0
    # ruleid: bpm-ch-rb-what-comment
    # loop through the orders
    orders.each do |order|
      # ruleid: bpm-ch-rb-what-comment
      # increment the total
      total += order.amount
    end
    # ruleid: bpm-ch-rb-step-narration
    # Step 1: validate the total
    raise ArgumentError, "negative total" if total.negative?
    # ruleid: bpm-ch-rb-prose-padding
    # It is important to note that totals are never cached.
    total
  end

  def login(user, password)
    # ruleid: bpm-log-rb-secret-field
    Rails.logger.info("Login attempt for #{user.email} with #{password}")
    # ruleid: bpm-log-rb-secret-field
    logger.debug(user.api_token)
  end

  def save(order)
    store.save(order)
  # ruleid: bpm-log-rb-and-reraise
  rescue => e
    logger.error("Saving order #{order.id} failed: #{e.message}")
    raise
  end
end
