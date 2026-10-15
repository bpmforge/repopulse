# The stdout rule fires only under a Rails application's request and job
# directories, which is why this fixture lives under app/controllers.
class OrdersController < ApplicationController
  def show
    @order = Order.find(params[:id])
    # ruleid: bpm-log-rb-stdout-in-app
    puts "showing order #{@order.id}"
    # ruleid: bpm-log-rb-stdout-in-app
    p @order
  end
end
