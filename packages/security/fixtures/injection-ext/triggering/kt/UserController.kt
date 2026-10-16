// Triggering fixture for bpm-baseline.injection.dotnet-kotlin-rust.v1.yaml.
// `// ruleid: <id>` names the rule that must fire on the NEXT line.
package demo

import java.io.File
import java.io.ObjectInputStream
import java.net.URL
import java.sql.Statement
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.servlet.view.RedirectView

class UserController {
    fun byName(@RequestParam name: String, stmt: Statement): String {
        // ruleid: bpm-inj-sql-kt
        stmt.execute("DELETE FROM users WHERE name = '$name'")
        return "ok"
    }

    fun ping(@RequestParam host: String) {
        // ruleid: bpm-inj-cmd-kt
        Runtime.getRuntime().exec("ping -c 1 " + host)
    }

    fun read(@RequestParam file: String): String {
        // ruleid: bpm-inj-path-kt
        return File(file).readText()
    }

    fun fetch(@RequestParam url: String): String {
        // ruleid: bpm-inj-ssrf-kt
        return URL(url).readText()
    }

    fun go(@RequestParam next: String): RedirectView {
        // ruleid: bpm-inj-redirect-kt
        return RedirectView(next)
    }

    fun load(@RequestBody payload: String): Any {
        // ruleid: bpm-inj-deserialize-kt
        val input = ObjectInputStream(payload.byteInputStream())
        return input.readObject()
    }
}
