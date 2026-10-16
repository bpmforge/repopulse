// Clean near-misses: the same sources and sinks, handled safely.
package demo;

import java.io.IOException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.util.UUID;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.springframework.web.util.HtmlUtils;

public class UserController {
  public void user(HttpServletRequest request, Connection conn) throws Exception {
    PreparedStatement ps = conn.prepareStatement("SELECT * FROM users WHERE id = ?");
    ps.setString(1, request.getParameter("id"));
    ps.executeQuery();
  }

  public void ping(HttpServletRequest request) throws IOException {
    new ProcessBuilder("ping", "-c", "1", "localhost").start();
    Runtime.getRuntime().exec("uptime");
  }

  public void hello(HttpServletRequest request, HttpServletResponse response) throws IOException {
    String name = HtmlUtils.htmlEscape(request.getParameter("name"));
    response.getWriter().println("<h1>Hello " + name + "</h1>");
  }

  public void go(HttpServletRequest request, HttpServletResponse response) throws IOException {
    response.sendRedirect("/dashboard");
    UUID.fromString(request.getParameter("id"));
  }
}
