// Clean near-misses for the Java web-weaknesses pack.
package demo;

import javax.naming.directory.DirContext;
import javax.naming.directory.SearchControls;
import javax.naming.ldap.Rdn;
import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.HttpSession;
import javax.xml.xpath.XPath;
import javax.xml.xpath.XPathFactory;
import org.w3c.dom.Document;

public class Web {
  void cookie(HttpServletResponse response) {
    Cookie c = new Cookie("sid", "abc");
    c.setSecure(true);
    c.setHttpOnly(true);
    response.addCookie(c);
  }

  void ldap(HttpServletRequest request, DirContext ctx, SearchControls controls) throws Exception {
    String user = request.getParameter("user");
    // The value travels as a filter argument, not as filter text.
    ctx.search("ou=people", "(uid={0})", new Object[] {user}, controls);
    // Or it is escaped for an LDAP filter first.
    ctx.search("ou=people", "(uid=" + Rdn.escapeValue(user) + ")", controls);
  }

  Object xpath(HttpServletRequest request, Document doc) throws Exception {
    String name = request.getParameter("name");
    XPath xp = XPathFactory.newInstance().newXPath();
    String ignored = name;
    return xp.evaluate("/users/user[@name='admin']", doc);
  }

  void session(HttpServletRequest request, HttpSession session) {
    // A parsed number holds no text an attacker chose.
    int page = Integer.parseInt(request.getParameter("page"));
    request.getSession().setAttribute("page", page);
    session.setAttribute("theme", "dark");
  }
}
