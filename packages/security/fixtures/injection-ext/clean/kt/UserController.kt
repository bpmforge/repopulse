// Clean near-misses: nothing here may fire.
package demo

import java.io.File
import java.net.URL
import java.sql.PreparedStatement
import java.sql.Statement
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.servlet.view.RedirectView

class UserController {
    fun byId(@RequestParam id: String, stmt: Statement): String {
        val n = id.toInt()
        stmt.execute("DELETE FROM users WHERE id = $n")
        return "ok"
    }

    fun byName(@RequestParam name: String, conn: java.sql.Connection) {
        val ps: PreparedStatement = conn.prepareStatement("SELECT * FROM users WHERE name = ?")
        ps.setString(1, name)
    }

    fun ping(@RequestParam host: String) {
        Runtime.getRuntime().exec(arrayOf("ping", "-c", "1", "localhost"))
    }

    fun read(@RequestParam file: String): String {
        return File("/srv/data/report.txt").readText()
    }

    fun fetch(): String = URL("https://api.example.com/status").readText()

    fun go(@RequestParam next: String): RedirectView = RedirectView("/home")

    fun load(@RequestBody payload: String): Any = payload.length
}
