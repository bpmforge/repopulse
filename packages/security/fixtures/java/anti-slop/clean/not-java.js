// A JavaScript file in a Java tree. The JS anti-slop pack would flag the
// empty catch below; the Java pack must not even read this file.
try {
  JSON.parse('{');
} catch (e) {}
