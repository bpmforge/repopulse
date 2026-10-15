# The near-misses: each is a shape the Ruby code-health rules must leave alone.

class OrderService
  def decode(json)
    JSON.parse(json)
  rescue JSON::ParserError
    nil
  end

  def archive(id)
    store.archive(id)
  rescue StandardError
    # Best-effort: the nightly sweep retries every id.
  end

  def touch(id)
    store.touch(id)
  rescue Errno::ENOENT
  end

  def load(id)
    store.find(id)
  rescue StandardError => e
    logger.warn("Order #{id} unavailable: #{e.message}")
    nil
  end

  def price(order)
    Integer(order.raw_price, exception: false)
  end

  # Subclasses decide how an order is priced.
  def strategy
    raise NotImplementedError, "#{self.class} must implement #strategy"
  end

  def resize
    raise NotImplementedError
  end

  def encode
    raise ArgumentError, "Not implemented for archived orders"
  end

  # Set operations

  def total(orders)
    # Amounts are in cents, so integer addition cannot lose precision.
    orders.sum(&:amount)
  end

  # Return the total
  def grand_total
    total(orders)
  end

  def login(user, password)
    Rails.logger.info("Login attempt for #{user.email}")
    logger.debug("password length #{password.length}")
    logger.info("Token refresh scheduled")
  end

  def save(order)
    store.save(order)
  rescue => e
    raise SaveFailed, "order #{order.id}: #{e.message}"
  end
end
