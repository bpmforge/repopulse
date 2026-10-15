# Near-misses for slop.repository_over_crud (W18-09).
from abc import ABC, abstractmethod

from .models import Customer, Invoice


class CustomerRepository:
    def __init__(self, session):
        self.session = session

    def get(self, customer_id):
        return self.session.get(Customer, customer_id)

    def all(self):
        return self.session.query(Customer).all()

    def to_domain(self, customer_id):
        row = self.session.get(Customer, customer_id)
        return {"id": row.id, "name": row.name.title()}


class InvoiceRepository:
    def __init__(self, session):
        self.session = session

    def open(self):
        return self.session.query(Invoice).filter(Invoice.paid == False).all()

    def overdue(self, today):
        return self.session.query(Invoice).filter(Invoice.due < today).order_by(Invoice.due.desc()).all()

    def largest(self):
        return self.session.query(Invoice).order_by(Invoice.total.desc()).first()


class BaseRepository(ABC):
    @abstractmethod
    def get(self, id):
        ...

    @abstractmethod
    def add(self, entity):
        raise NotImplementedError

    @abstractmethod
    def delete(self, entity):
        ...
