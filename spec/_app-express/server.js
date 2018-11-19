const Koa = require('koa')
const path = require('path')
const koaStatic = require('koa-static')
const express = require('express')
const app = new Koa()
app.use(koaStatic(path.join(__dirname, '../app-express.asar.unpacked/public')))

// app.use(async ctx => {
//   ctx.body = 'Hello World'
// })

// app.listen(3000)

app.listen(8234, 'localhost', () => {
  console.log('server start.')
})

const expressApp = express()
expressApp.use(express.static(path.join(__dirname, '../app-express.asar.unpacked/public')))
expressApp.listen(8235, 'localhost', () => {
  console.log('server start.')
})
