// Clean near-misses: nothing here may fire.
using System;
using System.Data.SqlClient;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using Microsoft.AspNetCore.Mvc;

public class UserController : Controller
{
    public IActionResult Find([FromQuery] int id)
    {
        var cmd = new SqlCommand("SELECT * FROM users WHERE id = " + id, conn);
        return Ok();
    }

    public IActionResult ByName([FromQuery] string name)
    {
        var cmd = new SqlCommand("SELECT * FROM users WHERE name = @name", conn);
        cmd.Parameters.AddWithValue("@name", name);
        var n = int.Parse(Request.Query["n"]);
        db.Database.ExecuteSqlRaw("DELETE FROM users WHERE id = " + n);
        return Ok();
    }

    public IActionResult Ping()
    {
        Process.Start("ping", "localhost");
        return Ok();
    }

    public IActionResult Read([FromQuery] string file)
    {
        var safe = Path.GetFileName(file);
        var text = System.IO.File.ReadAllText(Path.Combine("/srv/data", safe));
        return Content(text);
    }

    public IActionResult Greet([FromQuery] string name)
    {
        Response.WriteAsync("<h1>Hello " + WebUtility.HtmlEncode(name) + "</h1>");
        return Ok();
    }

    public async Task<IActionResult> Fetch()
    {
        var c = new HttpClient();
        var body = await c.GetStringAsync("https://api.example.com/status");
        return Ok(body);
    }

    public IActionResult Go([FromQuery] string next)
    {
        if (!Url.IsLocalUrl(next)) return BadRequest();
        return LocalRedirect(next);
    }

    public IActionResult Load([FromBody] string payload)
    {
        var obj = System.Text.Json.JsonSerializer.Deserialize<Dto>(payload);
        return Ok(obj);
    }
}
