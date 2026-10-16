// Triggering fixture for the injection pack (bpm-baseline.injection.v1.yaml).
// `// ruleid: <id>` names the rule that must fire on the NEXT line.
package demo;

import java.io.File;
import java.io.IOException;
import java.io.ObjectInputStream;
import java.net.URL;
import java.sql.Connection;
import java.sql.Statement;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.springframework.web.bind.annotation.RequestParam;

public class UserController {
  public void user(HttpServletRequest request, Connection conn) throws Exception {
    String id = request.getParameter("id");
    Statement stmt = conn.createStatement();
    // ruleid: bpm-inj-sql-java
    stmt.executeQuery("SELECT * FROM users WHERE id = '" + id + "'");
  }

  public String byName(@RequestParam String name, Statement stmt)
      throws Exception {
    // ruleid: bpm-inj-sql-java
    stmt.execute("DELETE FROM users WHERE name = '" + name + "'");
    return "ok";
  }

  public void ping(HttpServletRequest request) throws IOException {
    String host = request.getParameter("host");
    // ruleid: bpm-inj-cmd-java
    Runtime.getRuntime().exec("ping -c 1 " + host);
  }

  public File file(HttpServletRequest request) {
    String name = request.getParameter("file");
    // ruleid: bpm-inj-path-java
    return new File("/srv/uploads/" + name);
  }

  public void hello(HttpServletRequest request, HttpServletResponse response) throws IOException {
    String name = request.getParameter("name");
    // ruleid: bpm-inj-xss-java
    response.getWriter().println("<h1>Hello " + name + "</h1>");
  }

  public void fetch(HttpServletRequest request) throws Exception {
    String target = request.getParameter("url");
    // ruleid: bpm-inj-ssrf-java
    URL url = new URL(target);
    url.openStream();
  }

  public void go(HttpServletRequest request, HttpServletResponse response) throws IOException {
    // ruleid: bpm-inj-redirect-java
    response.sendRedirect(request.getParameter("next"));
  }

  public Object load(HttpServletRequest request) throws Exception {
    // ruleid: bpm-inj-deserialize-java
    return new ObjectInputStream(request.getInputStream()).readObject();
  }
}
