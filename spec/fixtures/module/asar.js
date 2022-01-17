const fs = require('fs');
process.on('message', function (file) {
  process.send(fs.readFileSync(file).toString(), (err) => {
    process.exit(err ? 1 : 0)
  });
});
