using System;
using System.Data.SqlClient;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Net.Security;
using System.Runtime.Serialization.Formatters.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Xml;
using Dapper;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using Newtonsoft.Json;

// Every construct below is one the C# security rules must flag. Each expected
// finding is announced by a `ruleid:` comment on the line above it.
namespace Example.Insecure
{
    public class OrderRepository
    {
        private readonly SqlConnection _conn;
        private readonly ShopContext _db;

        public object FindByName(string name)
        {
            // ruleid: bpm-cs-sql-string-concat
            var cmd = new SqlCommand("SELECT * FROM Orders WHERE Name = '" + name + "'", _conn);
            return cmd.ExecuteScalar();
        }

        public object FindInterpolated(string customer)
        {
            // ruleid: bpm-cs-sql-string-concat
            return _conn.QueryFirstOrDefault<Order>($"SELECT * FROM Orders WHERE Customer = '{customer}'");
        }

        public void Delete(string id)
        {
            var sql = "DELETE FROM Orders WHERE Id = " + id;
            using var cmd = _conn.CreateCommand();
            // ruleid: bpm-cs-sql-string-concat
            cmd.CommandText = sql;
            cmd.ExecuteNonQuery();
        }

        public void Purge(string tenant)
        {
            // ruleid: bpm-cs-sql-string-concat
            _db.Database.ExecuteSqlRaw($"DELETE FROM Carts WHERE Tenant = '{tenant}'");
        }
    }

    public class Tools
    {
        public void Archive(string folder)
        {
            // ruleid: bpm-cs-shell-command-built
            Process.Start("cmd.exe", "/c tar -czf backup.tgz " + folder);
        }

        public void Ping(string host)
        {
            // ruleid: bpm-cs-shell-command-built
            var psi = new ProcessStartInfo("/bin/bash", $"-c \"ping -c 1 {host}\"");
            Process.Start(psi);
        }

        public void Grep(string pattern)
        {
            var psi = new ProcessStartInfo();
            psi.FileName = "sh";
            // ruleid: bpm-cs-shell-command-built
            psi.Arguments = "-c 'grep " + pattern + " /var/log/app.log'";
            Process.Start(psi);
        }
    }

    public class Accounts
    {
        public string HashPassword(string password)
        {
            using (var md5 = MD5.Create())
            {
                // ruleid: bpm-cs-weak-hash-password
                return Convert.ToBase64String(md5.ComputeHash(Encoding.UTF8.GetBytes(password)));
            }
        }

        public byte[] Fingerprint(string user, string apiKey)
        {
            // ruleid: bpm-cs-weak-hash-password
            return SHA1.HashData(Encoding.UTF8.GetBytes(user + apiKey));
        }

        public string NewResetToken()
        {
            var bytes = new byte[16];
            // ruleid: bpm-cs-insecure-random-token
            new Random().NextBytes(bytes);
            return Convert.ToHexString(bytes);
        }

        public void Issue(User user)
        {
            var rng = new Random();
            // ruleid: bpm-cs-insecure-random-token
            user.SessionToken = rng.Next(100000, 999999).ToString();
        }
    }

    public class Transport
    {
        public HttpClient Build()
        {
            var handler = new HttpClientHandler();
            // ruleid: bpm-cs-cert-validation-disabled
            handler.ServerCertificateCustomValidationCallback = (msg, cert, chain, errors) => true;
            return new HttpClient(handler);
        }

        public HttpClient BuildDangerous()
        {
            var handler = new HttpClientHandler();
            // ruleid: bpm-cs-cert-validation-disabled
            handler.ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;
            return new HttpClient(handler);
        }

        public SslStream Wrap(Stream inner)
        {
            // ruleid: bpm-cs-cert-validation-disabled
            return new SslStream(inner, false, (sender, cert, chain, errors) => true);
        }
    }

    public class Session
    {
        public object Load(Stream body)
        {
            var formatter = new BinaryFormatter();
            // ruleid: bpm-cs-unsafe-deserializer
            return formatter.Deserialize(body);
        }

        public T Read<T>(string json)
        {
            var settings = new JsonSerializerSettings();
            // ruleid: bpm-cs-json-type-name-handling
            settings.TypeNameHandling = TypeNameHandling.All;
            return JsonConvert.DeserializeObject<T>(json, settings);
        }

        public XmlDocument Parse(Stream input)
        {
            var settings = new XmlReaderSettings();
            // ruleid: bpm-cs-xml-dtd-processing
            settings.DtdProcessing = DtdProcessing.Parse;
            var doc = new XmlDocument();
            doc.Load(XmlReader.Create(input, settings));
            return doc;
        }

        public TokenValidationParameters Jwt()
        {
            return new TokenValidationParameters
            {
                ValidateIssuer = true,
                // ruleid: bpm-cs-jwt-unsigned-accepted
                RequireSignedTokens = false,
            };
        }
    }
}
