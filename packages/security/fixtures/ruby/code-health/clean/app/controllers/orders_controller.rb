# The logger, not stdout: nothing here may produce a finding.
class OrdersController < ApplicationController
  def show
    @order = Order.find(params[:id])
    Rails.logger.info("showing order #{@order.id}")
  end
end
