// Triggering fixture: servlet request sources and path sinks written the other
// ways ordinary code writes them (W18-49). `// ruleid: <id>` names the rule
// that must fire on the NEXT line.
package demo;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.sql.Statement;
import java.util.Enumeration;
import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServletRequest;

public class RequestForms {
  // A request variable that is not called "request": its declared type is what
  // makes the value request data.
  public File typed(HttpServletRequest rq) {
    String name = rq.getParameter("file");
    // ruleid: bpm-inj-path-java
    return new File("/srv/uploads/" + name);
  }

  public File headerValue(HttpServletRequest request) {
    Enumeration<String> values = request.getHeaders("X-File");
    String name = values.nextElement();
    // ruleid: bpm-inj-path-java
    return new File("/srv/uploads/" + name);
  }

  public File headerName(HttpServletRequest request) {
    Enumeration<String> names = request.getHeaderNames();
    String name = names.nextElement();
    // ruleid: bpm-inj-path-java
    return new File("/srv/uploads/" + name);
  }

  public File fromCookie(HttpServletRequest request) {
    String name = "none";
    for (Cookie cookie : request.getCookies()) {
      name = cookie.getValue();
    }
    // ruleid: bpm-inj-path-java
    return new File("/srv/uploads/" + name);
  }

  // The tainted value is the DIRECTORY, not the file name.
  public File asParent(HttpServletRequest request) {
    String dir = request.getParameter("dir");
    // ruleid: bpm-inj-path-java
    return new File(dir, "report.txt");
  }

  // The same classes written fully qualified.
  public java.io.File qualified(HttpServletRequest request) {
    String name = request.getParameter("file");
    // ruleid: bpm-inj-path-java
    return new java.io.File("/srv/uploads/" + name);
  }

  public java.nio.file.Path qualifiedNio(HttpServletRequest request) {
    String name = request.getParameter("file");
    // ruleid: bpm-inj-path-java
    return java.nio.file.Paths.get("/srv/uploads", name);
  }

  public void sqlFromHeader(HttpServletRequest rq, Statement stmt) throws Exception {
    String who = rq.getHeader("X-User");
    // ruleid: bpm-inj-sql-java
    stmt.executeQuery("SELECT * FROM users WHERE name = '" + who + "'");
  }
}
