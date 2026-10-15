<?php
// The near-misses: each is a shape the PHP code-health rules must leave alone.

namespace App\Orders;

#[\Attribute]
class OrderService
{
    private $store;
    private $logger;

    public function decode($json)
    {
        try {
            return json_decode($json, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
        }
    }

    public function archive($id)
    {
        try {
            $this->store->archive($id);
        } catch (\Exception $e) {
            // Best-effort: the nightly sweep retries every id.
        }
        try {
            $this->store->touch($id);
        } catch (\Exception $e) {} // touch is advisory
    }

    public function find($id)
    {
        try {
            return $this->store->find($id);
        } catch (NotFoundException $e) {
            return null;
        }
    }

    public function load($id)
    {
        try {
            return $this->store->find($id);
        } catch (\Exception $e) {
            $this->logger->warning('Order unavailable', ['id' => $id, 'exception' => $e]);
            return null;
        }
    }

    public function resize()
    {
        throw new \LogicException('Not implemented for archived orders');
    }

    public function total(array $orders)
    {
        // Set operations

        $total = 0;
        // Amounts are in cents, so integer addition cannot lose precision.
        foreach ($orders as $order) {
            $total += $order['amount'];
        }
        return $total;
    }

    public function show($order)
    {
        $text = print_r($order, true);
        $code = var_export($order, true);
        $this->logger->debug('Order dump', ['order' => $text]);
        echo htmlspecialchars($order['name']);
    }

    public function login($user, $password)
    {
        $this->logger->info('Login attempt', ['user' => $user]);
        $this->logger->debug('Password length', ['length' => strlen($password)]);
        $this->logger->info('Token refresh scheduled for ' . $user);
    }

    public function save($order)
    {
        try {
            $this->store->save($order);
        } catch (\PDOException $e) {
            throw new SaveFailed($order['id'], 0, $e);
        }
    }
}
