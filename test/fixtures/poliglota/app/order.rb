require_relative 'helper'
class Order
  MAX_TOTAL = 500
  def total(items)
    return 0 if items.empty?
    items.sum { |i| price(i) }
  end
  def price(i)
    i > 3 ? 10 : 5
  end
end
