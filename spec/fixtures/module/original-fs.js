process.on('message', function () {
  process.send(typeof require('original-fs'), (err) => {
    process.exit(err ? 1 : 0)
  });
});
