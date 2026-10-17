// Triggering fixture for the Java web-weaknesses pack
// (bpm-baseline.java-web.v1.yaml, W18-49). `// ruleid: <id>` names the rule that
// must fire on the NEXT line. Written for this repository.
package demo;

import javax.naming.directory.DirContext;
import javax.naming.directory.SearchControls;
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
    // ruleid: bpm-java-cookie-insecure
    c.setSecure(false);
    response.addCookie(c);
  }

  void ldap(HttpServletRequest request, DirContext ctx, SearchControls controls) throws Exception {
    String user = request.getParameter("user");
    // ruleid: bpm-inj-ldap-java
    ctx.search("ou=people,dc=example,dc=com", "(uid=" + user + ")", controls);
  }

  void ldapWithArgs(HttpServletRequest rq, DirContext ctx, SearchControls controls)
      throws Exception {
    String user = rq.getHeader("X-User");
    // The value is in the filter TEXT; the argument array does not make it safe.
    // ruleid: bpm-inj-ldap-java
    ctx.search("ou=people", "(&(uid=" + user + ")(objectClass={0}))", new Object[] {"person"}, controls);
  }

  Object xpath(HttpServletRequest request, Document doc) throws Exception {
    String name = request.getParameter("name");
    XPath xp = XPathFactory.newInstance().newXPath();
    // ruleid: bpm-inj-xpath-java
    return xp.evaluate("/users/user[@name='" + name + "']", doc);
  }

  Object xpathCompiled(HttpServletRequest request, Document doc) throws Exception {
    String name = request.getParameter("name");
    javax.xml.xpath.XPath xp = XPathFactory.newInstance().newXPath();
    // ruleid: bpm-inj-xpath-java
    return xp.compile("//user[@name='" + name + "']");
  }

  void session(HttpServletRequest request) {
    String user = request.getParameter("user");
    // ruleid: bpm-inj-trust-java
    request.getSession().setAttribute("user", user);
  }

  void sessionVariable(HttpServletRequest request, HttpSession session) {
    String key = request.getParameter("key");
    // ruleid: bpm-inj-trust-java
    session.setAttribute(key, "1");
  }
}
