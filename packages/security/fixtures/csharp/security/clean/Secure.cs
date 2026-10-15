using System;
using System.Data.SqlClient;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Xml;
using Dapper;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Newtonsoft.Json;

// The safe versions of the same jobs, and the near-misses an earlier draft
// flagged. Nothing in this file may produce a finding.
namespace Example.Secure
{
    public class OrderRepository
    {
        private const string TABLE = "Orders";
        private readonly SqlConnection _conn;
        private readonly ShopContext _db;

        public object FindByName(string name)
        {
            var cmd = new SqlCommand("SELECT * FROM Orders WHERE Name = @name", _conn);
            cmd.Parameters.AddWithValue("@name", name);
            return cmd.ExecuteScalar();
        }

        public object FindByCustomer(string customer)
        {
            // Dapper binds the anonymous object's properties as parameters.
            return _conn.QueryFirstOrDefault<Order>("SELECT * FROM Orders WHERE Customer = @customer", new { customer });
        }

        public int Count()
        {
            // A constant spliced in is chosen by the code, not by a caller.
            var cmd = new SqlCommand("SELECT COUNT(*) FROM " + TABLE, _conn);
            return (int)cmd.ExecuteScalar();
        }

        public void Purge(string tenant)
        {
            // FromSql/ExecuteSql with an interpolated string parameterises it.
            _db.Database.ExecuteSql($"DELETE FROM Carts WHERE Tenant = {tenant}");
        }

        public void Log(string message)
        {
            // Not SQL: an Execute on some other API with a concatenated label.
            _bus.Execute("notify: " + message);
        }
    }

    public class Tools
    {
        public void Archive(string folder)
        {
            // The program started directly, its arguments a list: no shell.
            var psi = new ProcessStartInfo("tar");
            psi.ArgumentList.Add("-czf");
            psi.ArgumentList.Add("backup.tgz");
            psi.ArgumentList.Add(folder);
            Process.Start(psi);
        }

        public void ListRoot()
        {
            Process.Start("cmd.exe", "/c dir C:\\");
        }

        public void OpenEditor(string file)
        {
            Process.Start("notepad.exe", file);
        }
    }

    public class Accounts
    {
        public string Checksum(Stream content)
        {
            // An MD5 for an ETag: nothing secret is hashed.
            using (var md5 = MD5.Create())
            {
                return Convert.ToHexString(md5.ComputeHash(content));
            }
        }

        public byte[] HashPassword(string password, byte[] salt)
        {
            return Rfc2898DeriveBytes.Pbkdf2(password, salt, 600_000, HashAlgorithmName.SHA256, 32);
        }

        public string NewResetToken()
        {
            return Convert.ToHexString(RandomNumberGenerator.GetBytes(16));
        }

        public TimeSpan Jitter()
        {
            return TimeSpan.FromMilliseconds(new Random().Next(0, 250));
        }

        public void Shuffle(int[] deck)
        {
            var rng = new Random(42);
            var tokenCount = deck.Length;
            for (var i = tokenCount - 1; i > 0; i--)
            {
                var j = rng.Next(i + 1);
                (deck[i], deck[j]) = (deck[j], deck[i]);
            }
        }
    }

    public class Transport
    {
        public HttpClient Build(bool allowUntrusted)
        {
            var handler = new HttpClientHandler();
            // A named, configurable opt-in is a decision someone can see.
            if (allowUntrusted)
            {
                handler.ServerCertificateCustomValidationCallback = (msg, cert, chain, errors) => errors == System.Net.Security.SslPolicyErrors.None || cert?.Thumbprint == PinnedThumbprint;
            }
            return new HttpClient(handler);
        }

        private const string PinnedThumbprint = "00";
    }

    public class Session
    {
        public T Load<T>(Stream body)
        {
            return System.Text.Json.JsonSerializer.Deserialize<T>(body);
        }

        public T Read<T>(string json)
        {
            var settings = new JsonSerializerSettings
            {
                TypeNameHandling = TypeNameHandling.Auto,
                SerializationBinder = new KnownTypesBinder(),
            };
            return JsonConvert.DeserializeObject<T>(json, settings);
        }

        public T ReadPlain<T>(string json)
        {
            var settings = new JsonSerializerSettings { TypeNameHandling = TypeNameHandling.None };
            return JsonConvert.DeserializeObject<T>(json, settings);
        }

        public XmlReader Parse(Stream input)
        {
            var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit };
            return XmlReader.Create(input, settings);
        }

        public TokenValidationParameters Jwt(SecurityKey key)
        {
            return new TokenValidationParameters
            {
                ValidateIssuerSigningKey = true,
                IssuerSigningKey = key,
                RequireSignedTokens = true,
            };
        }
    }
}
