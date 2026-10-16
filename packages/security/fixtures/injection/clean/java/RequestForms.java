// Clean near-misses for the request forms in the triggering RequestForms.java.
package demo;

import java.io.File;
import java.sql.Connection;
import java.sql.PreparedStatement;
import javax.servlet.http.HttpServletRequest;
import org.apache.commons.io.FilenameUtils;

public class RequestForms {
  // Reduced to a bare file name before it reaches the path.
  public File sanitised(HttpServletRequest rq) {
    String name = FilenameUtils.getName(rq.getParameter("file"));
    return new File("/srv/uploads/" + name);
  }

  // A helper in the SAME file that ignores its argument and returns a constant:
  // only an engine that follows the call can see the request value is dropped.
  private String fixedName(String requested) {
    return "report.txt";
  }

  public File throughHelper(HttpServletRequest request) {
    return new File("/srv/uploads/" + fixedName(request.getParameter("file")));
  }

  // A request value the directory never sees.
  public File notThePath(HttpServletRequest request) {
    String ignored = request.getParameter("note");
    return new File("/srv/uploads/report.txt");
  }

  public void bound(HttpServletRequest rq, Connection conn) throws Exception {
    PreparedStatement ps = conn.prepareStatement("SELECT * FROM users WHERE name = ?");
    ps.setString(1, rq.getHeader("X-User"));
    ps.executeQuery();
  }
}
