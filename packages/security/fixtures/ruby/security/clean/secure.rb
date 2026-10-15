# The safe versions of the same jobs, and the near-misses an earlier draft
# flagged. Nothing in this file may produce a finding.

class OrdersController < ApplicationController
  SORTABLE = %w[created_at total].freeze

  def index
    @orders = Order.where("customer = ?", params[:customer])
    @named = Order.where(customer: params[:customer])
    @sorted = Order.order(SORTABLE.include?(params[:sort]) ? params[:sort] : "created_at")
    @recent = Order.where("created_at > #{30.days.ago.to_i}")
    # Interpolated, but nothing from the request: a table name.
    @scoped = Order.where("#{Order.quoted_table_name}.state = ?", params[:state])
    # Rails 6.1+ refuses a non-column string in order/pluck.
    @by = Order.order(params[:sort])
    @limited = Order.where("id > #{params[:after].to_i}")
    @joined = Order.joins("JOIN #{quoted_table_name} t ON t.id = orders.parent_id")
    @quoted = Order.where("name = #{connection.quote(params[:name])}")
    @label = Order.where("status = 'open'")
  end

  def export
    system("tar", "-czf", "/tmp/export.tgz", params[:folder])
    system("tar -czf /tmp/export.tgz #{Shellwords.escape(params[:folder])}")
    system("make #{TARGET}")
    `git rev-parse HEAD`
    `ps -o pid,rss -p #{pid}`
    raise ArgumentError, "method `#{name}` already defined in #{controller}"
    send_file Rails.root.join("exports", File.basename(params[:file]))
  end

  def report
    klass = { "csv" => CsvReport, "pdf" => PdfReport }.fetch(params[:type])
    @order.public_send(:total)
    event = params[:e]
    @order.send("#{event}!") if %w[ship cancel].include?(event)
    if @order.state_events.include?(params[:e].to_sym) && @order.send("#{params[:e]}!")
      flash[:notice] = "updated"
    end
    define_method(:"#{name}=") { |value| value }
    klass.new
  end

  def restore
    cart = JSON.parse(cookies[:cart])
    prefs = YAML.safe_load(params[:prefs], permitted_classes: [Symbol])
    cache = Marshal.load(File.binread(cache_path))
    [cart, prefs, cache]
  end

  def update
    @order.update(params.require(:order).permit(:note, :address))
    redirect_to orders_path
    redirect_to params[:return_to], allow_other_host: false
    redirect_to request.referer, allow_other_host: allow_other_host
  end

  def banner
    content_tag(:div, params[:message], class: "banner")
    "<div class='banner'>#{h(params[:message])}</div>".html_safe
    "<span>#{t('orders.title')}</span>".html_safe
    "<span class=\"#{css_class}\">#{helpers.tag_options(options)}</span>".html_safe
  end
end

# ActionController's own Parameters: `params` here is a local, not the request.
class Parameters
  def permit(filters)
    params = dup
    params.permit!
  end
end

# `params` as a method's own argument is not the request.
class StatementCache
  def execute(params, connection)
    sql = query_builder.sql_for(params, connection)
    klass.find_by_sql(sql, params)
  end

  def hidden_fields(params)
    params.map { |k, v| "<input type=hidden name=#{k} value=#{v}>" }.join.html_safe
  end
end

class Client
  def connect(http, options)
    http.verify_mode = OpenSSL::SSL::VERIFY_PEER
    http.verify_mode = options[:insecure] ? OpenSSL::SSL::VERIFY_NONE : OpenSSL::SSL::VERIFY_PEER
    Faraday.new(url: "https://api.example.com", ssl: { verify: true })
  end
end

class User
  def self.digest(password)
    BCrypt::Password.create(password)
  end

  def digest_ha1(credentials, password)
    # HTTP Digest's HA1 is defined as MD5(user:realm:password).
    OpenSSL::Digest::MD5.hexdigest([credentials[:username], credentials[:realm], password].join(":"))
  end

  def etag
    Digest::MD5.hexdigest(updated_at.to_s)
  end

  def reset!
    self.reset_token = SecureRandom.urlsafe_base64(32)
    self.jitter = rand(100)
    password_length = rand(8..12)
    save!
  end
end
