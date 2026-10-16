// Triggering fixture for bpm-baseline.injection.dotnet-kotlin-rust.v1.yaml.
// `// ruleid: <id>` names the rule that must fire on the NEXT line.
using System;
using System.Data.SqlClient;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.Serialization.Formatters.Binary;
using Microsoft.AspNetCore.Mvc;

public class UserController : Controller
{
    public IActionResult Find()
    {
        var id = Request.Query["id"];
        // ruleid: bpm-inj-sql-cs
        var cmd = new SqlCommand("SELECT * FROM users WHERE id = " + id, conn);
        return Ok();
    }

    public IActionResult ByName([FromQuery] string name)
    {
        // ruleid: bpm-inj-sql-cs
        db.Database.ExecuteSqlRaw($"DELETE FROM users WHERE name = '{name}'");
        return Ok();
    }

    public IActionResult Ping([FromQuery] string host)
    {
        // ruleid: bpm-inj-cmd-cs
        Process.Start("ping", host);
        return Ok();
    }

    public IActionResult Read([FromQuery] string file)
    {
        // ruleid: bpm-inj-path-cs
        var text = System.IO.File.ReadAllText(file);
        return Content(text);
    }

    public IActionResult Greet([FromQuery] string name)
    {
        // ruleid: bpm-inj-xss-cs
        Response.WriteAsync("<h1>Hello " + name + "</h1>");
        return Ok();
    }

    public async Task<IActionResult> Fetch([FromQuery] string url)
    {
        var c = new HttpClient();
        // ruleid: bpm-inj-ssrf-cs
        var body = await c.GetStringAsync(url);
        return Ok(body);
    }

    public IActionResult Go([FromQuery] string next)
    {
        // ruleid: bpm-inj-redirect-cs
        return Redirect(next);
    }

    public IActionResult Load([FromBody] string payload)
    {
        var formatter = new BinaryFormatter();
        // ruleid: bpm-inj-deserialize-cs
        var obj = formatter.Deserialize(new MemoryStream(Convert.FromBase64String(payload)));
        return Ok(obj);
    }
}
