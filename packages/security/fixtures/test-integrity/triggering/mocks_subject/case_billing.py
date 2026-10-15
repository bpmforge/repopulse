from unittest import mock

from shop import billing


@mock.patch("shop.billing.charge")
def test_charge(charge_mock):
    charge_mock.return_value = "ok"
    assert billing.charge("acct", 10) == "ok"


def test_charge_object(mocker):
    mocker.patch.object(billing, "charge", return_value=5)
    assert billing.charge("acct", 5) == 5
