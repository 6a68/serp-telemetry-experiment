See https://bugzil.la/1174937 for much more context.

I don't really use mercurial, so I'm keeping the git work-in-progress code here.

#### One way to generate a diff to upload to bugzilla:

- For each file, just `diff -u /dev/null filename >> foo.patch`. This will append the contents to the patch.
- The list of files that matters seems to be manifest.json, code/bootstrap.js, code/install.rdf, DOCUMENTATION.

License: MPL 2.0

Author: [Jared Hirsch](https://github.com/6a68)
