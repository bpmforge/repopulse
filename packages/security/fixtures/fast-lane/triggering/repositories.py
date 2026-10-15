# Fixture for slop.repository_over_crud (W18-09).
from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Order


# expect: slop.repository_over_crud
class OrderRepository:
    """Data access for orders."""

    def __init__(self, session: Session):
        self.session = session

    def get(self, order_id: int):
        """Fetch one order."""
        return self.session.get(Order, order_id)

    def list_for_customer(self, customer_id: int):
        return self.session.query(Order).filter(Order.customer_id == customer_id).all()

    async def find(self, order_id: int):
        return (await self.session.execute(select(Order).where(Order.id == order_id))).scalar_one_or_none()

    def add(self, order: Order):
        self.session.add(order)

    def delete(self, order: Order):
        self.session.delete(order)
