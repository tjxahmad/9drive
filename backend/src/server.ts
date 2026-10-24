import { app } from './app.js'
import { env } from './config/env.js'

app.listen(env.APP_PORT, env.HOST, () => {
  console.log(`Backend running on http://${env.HOST}:${env.APP_PORT}`)
})
