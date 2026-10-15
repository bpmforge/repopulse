# Every construct below is one the Ruby security rules must flag. Each expected
# finding is announced by a `ruleid:` comment on the line above it.

class OrdersController < ApplicationController
  def index
    # ruleid: bpm-rb-sql-from-request
    @orders = Order.where("customer = '#{params[:customer]}'")
    name = params[:name]
    # ruleid: bpm-rb-sql-from-request
    @named = Order.find_by_sql("SELECT * FROM orders WHERE name = '" + name + "'")
    # ruleid: bpm-rb-sql-from-request
    @rows = ActiveRecord::Base.connection.execute("DELETE FROM carts WHERE token = '#{cookies[:cart]}'")
  end

  def export
    # ruleid: bpm-rb-shell-interpolation
    system("tar -czf /tmp/export.tgz #{params[:folder]}")
    # ruleid: bpm-rb-shell-interpolation
    output = `git log --author=#{current_user.name} --since=#{since}`
    # ruleid: bpm-rb-shell-interpolation
    stdout, status = Open3.capture2("convert #{upload.path} out.png")
    # ruleid: bpm-rb-file-from-request
    send_file Rails.root.join("exports", params[:file])
  end

  def report
    # ruleid: bpm-rb-code-from-request
    klass = params[:type].constantize
    # ruleid: bpm-rb-code-from-request
    @order.send(params[:field])
    klass.new
  end

  def restore
    # ruleid: bpm-rb-deserialize-request
    cart = Marshal.load(Base64.decode64(cookies[:cart]))
    # ruleid: bpm-rb-deserialize-request
    prefs = YAML.unsafe_load(params[:prefs])
    [cart, prefs]
  end

  def update
    # ruleid: bpm-rb-permit-all-params
    @order.update(params.require(:order).permit!)
    # ruleid: bpm-rb-open-redirect
    redirect_to params[:return_to]
  end

  def banner
    # ruleid: bpm-rb-html-safe-request
    "<div class='banner'>#{params[:message]}</div>".html_safe
  end
end

class Client
  def connect(http)
    # ruleid: bpm-rb-tls-verify-none
    http.verify_mode = OpenSSL::SSL::VERIFY_NONE
    # ruleid: bpm-rb-tls-verify-none
    Faraday.new(url: "https://api.example.com", ssl: { verify: false })
  end
end

class User
  def self.digest(password)
    # ruleid: bpm-rb-weak-hash-password
    Digest::MD5.hexdigest(password)
  end

  def reset!
    # ruleid: bpm-rb-insecure-random-token
    self.reset_token = rand(36**20).to_s(36)
    # ruleid: bpm-rb-insecure-random-token
    api_key = (("a".."z").to_a + ("0".."9").to_a).sample(32).join
    save!
    api_key
  end
end
