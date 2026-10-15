using System;
using System.Collections.Generic;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

// Every construct below is one the C# anti-slop and logging rules must flag.
// Each expected finding is announced by a `ruleid:` comment on the line above.
namespace Example.Slop
{
    public class OrderService
    {
        private readonly ILogger<OrderService> _logger;
        private readonly IOrderStore _store;

        public void Archive(int id)
        {
            try
            {
                _store.Archive(id);
            }
            // ruleid: bpm-ch-cs-empty-catch
            catch (Exception ex)
            {
            }
        }

        public void Touch(int id)
        {
            try
            {
                _store.Touch(id);
            }
            // ruleid: bpm-ch-cs-empty-catch
            catch { }
        }

        public List<Order> Recent()
        {
            try
            {
                return _store.Recent();
            }
            // ruleid: bpm-ch-cs-silent-fallback
            catch (Exception)
            {
                return new List<Order>();
            }
        }

        public Order Find(int id)
        {
            try
            {
                return _store.Find(id);
            }
            // ruleid: bpm-ch-cs-silent-fallback
            catch
            {
                return null;
            }
        }

        public void ImportAll(IEnumerable<string> rows)
        {
            foreach (var row in rows)
            {
                try
                {
                    _store.Import(row);
                }
                // ruleid: bpm-ch-cs-catch-continue-in-loop
                catch (Exception e)
                {
                    continue;
                }
            }
        }

        public void Export()
        {
            // ruleid: bpm-ch-cs-stub-as-feature
            throw new InvalidOperationException("Not yet implemented");
        }

        public int Total(IList<Order> orders)
        {
            var total = 0;
            // ruleid: bpm-ch-cs-what-comment
            // loop through the orders
            foreach (var order in orders)
            {
                // ruleid: bpm-ch-cs-what-comment
                // increment the total
                total += order.Amount;
            }
            // ruleid: bpm-ch-cs-step-narration
            // Step 1: validate the total
            if (total < 0) throw new ArgumentException("negative total");
            // ruleid: bpm-ch-cs-prose-padding
            // It is important to note that totals are never cached.
            return total;
        }

        public void Login(string user, string password)
        {
            // ruleid: bpm-log-cs-secret-field
            _logger.LogInformation("Login attempt for {User} with {Password}", user, password);
        }

        public void Save(Order order)
        {
            // ruleid: bpm-log-cs-and-rethrow
            try
            {
                _store.Save(order);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Saving order {Id} failed", order.Id);
                throw;
            }
        }
    }

    public class OrdersController : ControllerBase
    {
        public void Ping()
        {
            // ruleid: bpm-log-cs-console-in-web
            Console.Write("pong");
        }

        [HttpGet("{id}")]
        public IActionResult Get(int id)
        {
            // ruleid: bpm-log-cs-console-in-web
            Console.WriteLine($"GET order {id}");
            return Ok();
        }

        [HttpPost("{id}/refund")]
        public IActionResult Refund(int id)
        {
            // ruleid: bpm-ch-cs-stub-as-feature
            throw new NotImplementedException();
        }
    }

    [Route("api/[controller]")]
    public sealed class CartController : Controller, IDisposable
    {
        public void Dispose() { }

        public IActionResult Clear()
        {
            // ruleid: bpm-log-cs-console-in-web
            Console.WriteLine("clearing cart");
            return Ok();
        }
    }
}
