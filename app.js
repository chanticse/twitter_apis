const express = require('express')
const path = require('path')
const {open} = require('sqlite')
const sqlite3 = require('sqlite3')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')

const app = express()
app.use(express.json())

const dbpath = path.join(__dirname, 'twitterClone.db')

let db = null

const initializeDBAndServer = async () => {
  try {
    db = await open({
      filename: dbpath,
      driver: sqlite3.Database,
    })
    app.listen(3000, () => {
      console.log('Server started')
    })
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}

initializeDBAndServer()

app.post('/register/', async (request, response) => {
  const {username, password, name, gender} = request.body
  const q = 'SELECT * FROM user WHERE username = ?;'
  const dbu = await db.get(q, [username])

  if (dbu !== undefined) {
    response.status(400).send('User already exists')
  } else {
    if (password.length < 6) {
      response.status(400).send('Password is too short')
    } else {
      const hashedPassword = await bcrypt.hash(password, 10)
      const q4 = `
       INSERT INTO user(username, password, name, gender)
       VALUES (?, ?, ?, ?);`
      await db.run(q4, [username, hashedPassword, name, gender])
      response.send('User created successfully')
    }
  }
})

app.post('/login/', async (request, response) => {
  const {username, password} = request.body
  const q = 'SELECT * FROM user WHERE username = ?;'
  const dbu = await db.get(q, [username])

  if (dbu !== undefined) {
    const ispc = await bcrypt.compare(password, dbu.password)

    if (ispc) {
      const payload = {username, userId: dbu.user_id}
      const jwtToken = jwt.sign(payload, 'SECRET_KEY')
      response.send({jwtToken})
    } else {
      response.status(400).send('Invalid password')
    }
  } else {
    response.status(400).send('Invalid user')
  }
})

function authenticateToken(request, response, next) {
  const authHeader = request.headers['authorization']

  if (authHeader === undefined) {
    return response.status(401).send('Invalid JWT Token')
  }

  const jwtToken = authHeader.split(' ')[1]
  if (jwtToken === undefined) {
    return response.status(401).send('Invalid JWT Token')
  } else {
    jwt.verify(jwtToken, 'SECRET_KEY', (error, payload) => {
      if (error) {
        return response.status(401).send('Invalid JWT Token')
      } else {
        request.user = payload
        next()
      }
    })
  }
}

const tweetResponse = db => ({
  username: db.username,
  tweet: db.tweet,
  dateTime: db.date_time,
})

app.get('/user/tweets/feed/', authenticateToken, async (request, response) => {
  const q1 = await db.all(
    `
    SELECT 
      tweet.tweet_id,
      tweet.user_id, user.username, tweet.tweet, tweet.date_time
    FROM 
      follower
      LEFT JOIN tweet ON tweet.user_id = follower.following_user_id
      LEFT JOIN user ON follower.following_user_id = user.user_id
    WHERE 
      follower.follower_user_id = (SELECT user_id FROM user WHERE username = ?)
    ORDER BY 
      tweet.date_time DESC
    LIMIT 4;`,
    [request.user.username],
  )
  response.send(q1.map(each => tweetResponse(each)))
})

app.get('/user/following/', authenticateToken, async (request, response) => {
  const q2 = await db.all(
    `
    SELECT user.name
    FROM follower
    LEFT JOIN user ON follower.following_user_id = user.user_id
    WHERE follower.follower_user_id = (SELECT user_id FROM user WHERE username = ?);`,
    [request.user.username],
  )
  response.send(q2)
})

app.get('/user/followers/', authenticateToken, async (request, response) => {
  const q3 = await db.all(
    `
    SELECT user.name
    FROM follower 
    LEFT JOIN user ON follower.follower_user_id = user.user_id
    WHERE follower.following_user_id = (SELECT user_id FROM user WHERE username = ?);`,
    [request.user.username],
  )
  response.send(q3)
})

const follows = async (request, response, next) => {
  const {tweetId} = request.params
  let isf = await db.get(
    `
    SELECT *
    FROM follower
    WHERE 
      follower_user_id = (SELECT user_id FROM user WHERE username = ?)
      AND
      following_user_id = (SELECT user.user_id FROM tweet NATURAL JOIN user WHERE tweet_id = ?);`,
    [request.user.username, tweetId],
  )
  if (isf === undefined) {
    response.status(401).send('Invalid Request')
  } else {
    next()
  }
}

app.get(
  '/tweets/:tweetId/',
  authenticateToken,
  follows,
  async (request, response) => {
    const {tweetId} = request.params
    const {tweet, date_time} = await db.get(
      `
      SELECT tweet, date_time
      FROM tweet
      WHERE tweet_id = ?;`,
      [tweetId],
    )
    const {likes} = await db.get(
      `SELECT COUNT(like_id) AS likes FROM like WHERE tweet_id = ?;`,
      [tweetId],
    )
    const {replies} = await db.get(
      `SELECT COUNT(reply_id) AS replies FROM reply WHERE tweet_id = ?;`,
      [tweetId],
    )
    response.send({tweet, likes, replies, dateTime: date_time})
  },
)

app.get(
  '/tweets/:tweetId/likes/',
  authenticateToken,
  follows,
  async (request, response) => {
    const {tweetId} = request.params
    const likeBy = await db.all(
      `
      SELECT user.username FROM like NATURAL JOIN user 
      WHERE tweet_id = ?;`,
      [tweetId],
    )
    response.send({likes: likeBy.map(each => each.username)})
  },
)

app.get(
  '/tweets/:tweetId/replies/',
  authenticateToken,
  follows,
  async (request, response) => {
    try {
      const {tweetId} = request.params

      // Get the replies for the specified tweetId
      const replies = await db.all(
        `
            SELECT user.username, reply.reply 
            FROM reply
            INNER JOIN user ON reply.user_id = user.user_id
            WHERE reply.tweet_id = ?;`,
        [tweetId],
      )

      // Get the tweet details
      const tweetDetails = await db.get(
        `
            SELECT tweet, date_time
            FROM tweet
            WHERE tweet_id = ?;`,
        [tweetId],
      )

      if (!tweetDetails) {
        return response.status(404).send('Tweet not found')
      }

      // Send the response with tweet and replies
      const responseData = {
        tweet: {
          tweet: tweetDetails.tweet,
          dateTime: tweetDetails.date_time,
        },
        replies,
      }

      response.send(responseData)
    } catch (error) {
      console.error(error)
      response.status(500).send('Internal Server Error')
    }
  },
)

app.get('/user/tweets/', authenticateToken, async (request, response) => {
  const q11 = await db.all(
    `
    SELECT
      tweet.tweet,
      COUNT(DISTINCT like.like_id) AS likes,
      COUNT(DISTINCT reply.reply_id) AS replies,
      tweet.date_time 
    FROM tweet
    LEFT JOIN like ON tweet.tweet_id = like.tweet_id
    LEFT JOIN reply ON tweet.tweet_id = reply.tweet_id
    WHERE tweet.user_id = (SELECT user_id FROM user WHERE username = ?)
    GROUP BY tweet.tweet_id;`,
    [request.user.username],
  )
  response.send(
    q11.map(each => {
      const {date_time, ...rest} = each
      return {...rest, dateTime: date_time}
    }),
  )
})

app.post('/user/tweets/', authenticateToken, async (request, response) => {
  const {tweet} = request.body
  const dateTime = new Date().toJSON().substring(0, 19).replace('T', ' ')

  const {user_id} = await db.get(
    `
    SELECT user_id FROM user WHERE username = ?;`,
    [request.user.username],
  )
  await db.run(
    `
    INSERT INTO tweet (tweet, user_id)
    VALUES (?, ?);`,
    [tweet, user_id],
  )

  response.send('Created a Tweet')
})

app.delete(
  '/tweets/:tweetId/',
  authenticateToken,
  async (request, response) => {
    const {tweetId} = request.params
    const {userId} = request.user

    const pq = `
      SELECT * 
      FROM tweet 
      WHERE tweet_id = ? 
        AND user_id = (SELECT user_id FROM user WHERE username = ?);`
    const tweet = await db.get(pq, [tweetId, request.user.username])

    if (tweet === undefined) {
      response.status(401).send('Invalid Request')
    } else {
      const dq = `
        DELETE FROM tweet 
        WHERE tweet_id = ?;`
      await db.run(dq, [tweetId])
      response.send('Tweet Removed')
    }
  },
)

module.exports = app
