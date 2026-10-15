<?php
// Every construct below is one the PHP anti-slop and logging rules must flag.
// Each expected finding is announced by a `ruleid:` comment on the line above.

namespace App\Orders;

class OrderService
{
    private $store;
    private $logger;

    public function archive($id)
    {
        try {
            $this->store->archive($id);
            // ruleid: bpm-ch-php-empty-catch
        } catch (\Exception $e) {
        }
    }

    public function recent()
    {
        try {
            return $this->store->recent();
            // ruleid: bpm-ch-php-silent-fallback
        } catch (\Throwable $e) {
            return [];
        }
    }

    public function refund($id)
    {
        // ruleid: bpm-ch-php-stub-as-feature
        throw new \RuntimeException('Not implemented');
    }

    public function total(array $orders)
    {
        $total = 0;
        // ruleid: bpm-ch-php-what-comment
        // loop through the orders
        foreach ($orders as $order) {
            // ruleid: bpm-ch-php-what-comment
            # increment the $total
            $total += $order['amount'];
        }
        // ruleid: bpm-ch-php-step-narration
        // Step 1: validate the total
        if ($total < 0) {
            throw new \InvalidArgumentException('negative total');
        }
        // ruleid: bpm-ch-php-prose-padding
        // It is important to note that totals are never cached.
        return $total;
    }

    public function show($order)
    {
        // ruleid: bpm-log-php-debug-dump
        var_dump($order);
        // ruleid: bpm-log-php-debug-dump
        print_r($order);
    }

    public function login($user, $password)
    {
        // ruleid: bpm-log-php-secret-field
        $this->logger->info('Login attempt', ['user' => $user, 'password' => $password]);
        // ruleid: bpm-log-php-secret-field
        error_log('token was ' . $_SESSION['token']);
    }

    public function save($order)
    {
        // ruleid: bpm-log-php-and-rethrow
        try {
            $this->store->save($order);
        } catch (\PDOException $e) {
            $this->logger->error('Saving order failed', ['exception' => $e]);
            throw $e;
        }
    }
}
