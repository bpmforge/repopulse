from unittest import mock

from shop import orders


@mock.patch("shop.orders.requests")
def test_submit_posts_the_order(requests_mock):
    # Patches a DEPENDENCY as seen from the subject: the right way to mock.
    orders.submit({"id": 1})
    requests_mock.post.assert_called_once()


@mock.patch("shop.orders.audit", wraps=orders.audit)
def test_submit_audits(audit_spy):
    orders.submit({"id": 2})
    assert audit_spy.call_count == 1
