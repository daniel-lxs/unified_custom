import { main } from '../index';

describe('main', () => {
  it('should apply simple diff correctly', async () => {
    const original = `line1
line2
line3`;

    const diff = `--- a/file.txt
+++ b/file.txt
@@ ... @@
 line1
+new line
 line2
-line3
+modified line3`;

    const result = await main(original, diff, true);
    
    expect(result).toBe(`line1
new line
line2
modified line3`);
  });

  it('should handle multiple hunks', async () => {
    const original = `line1
line2
line3
line4
line5`;

    const diff = `--- a/file.txt
+++ b/file.txt
@@ ... @@
 line1
+new line
 line2
-line3
+modified line3
@@ ... @@
 line4
-line5
+modified line5
+new line at end`;

    const result = await main(original, diff, true);
    
    expect(result).toBe(`line1
new line
line2
modified line3
line4
modified line5
new line at end`);
  });

  it('should handle complex large', async () => {
    const original = `line1
line2
line3
line4
line5
line6
line7
line8
line9
line10`;

    const diff = `--- a/file.txt
+++ b/file.txt
@@ ... @@
 line1
+header line
+another header
 line2
-line3
-line4
+modified line3
+modified line4
+extra line
@@ ... @@
 line6
+middle section
 line7
-line8
+changed line8
+bonus line
@@ ... @@
 line9
-line10
+final line
+very last line`;

    const result = await main(original, diff, true);
    
    expect(result).toBe(`line1
header line
another header
line2
modified line3
modified line4
extra line
line5
line6
middle section
line7
changed line8
bonus line
line9
final line
very last line`);
  });

  it('should handle indentation changes', async () => {
    const original = `first line
  indented line
    double indented line
  back to single indent
no indent
  indented again
    double indent again
      triple indent
  back to single
last line`;

    const diff = `--- original
+++ modified
@@ ... @@
 first line
   indented line
+	tab indented line
+  new indented line
     double indented line
   back to single indent
 no indent
   indented again
     double indent again
-      triple indent
+      hi there mate
   back to single
 last line`;

    const expected = `first line
  indented line
	tab indented line
  new indented line
    double indented line
  back to single indent
no indent
  indented again
    double indent again
      hi there mate
  back to single
last line`;

    const result = await main(original, diff, true);
    console.log('Result:', result);
    expect(result).toBe(expected);
  });

  it('should handle high level edits', async () => {

    const original = `def factorial(n):
    if n == 0:
        return 1
    else:
        return n * factorial(n-1)`
    const diff = `@@ ... @@
-def factorial(n):
-    if n == 0:
-        return 1
-    else:
-        return n * factorial(n-1)
+def factorial(number):
+    if number == 0:
+        return 1
+    else:
+        return number * factorial(number-1)`

const expected = `def factorial(number):
    if number == 0:
        return 1
    else:
        return number * factorial(number-1)`

    const result = await main(original, diff, true);
    expect(result).toBe(expected);
  });
});
