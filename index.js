const express = require('express');
const dotenv = require('dotenv');

const app = express();
const cors = require('cors');
dotenv.config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

const PORT = process.env.PORT;

app.use(cors());
app.use(express.json());

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // Connect the client to the server	(optional starting in v4.7)
        await client.connect();

        const db = client.db(process.env.AUTH_DB_NAME);
        const usersCollection = db.collection("user");
        const lessonsCollection = db.collection("lessons");

        app.get('/my-lessons', async (req, res) => {
            const userId = req.query.userId;

            const result = await lessonsCollection
                .find({ userId: userId })
                .sort({ createdAt: -1 })
                .toArray();

            res.send(result);
        });

        app.post('/lessons/add', async (req, res) => {
            const lesson = req.body;
            const newLesson = {
                ...lesson,
                createdAt: new Date()
            }
            const result = await lessonsCollection.insertOne(newLesson);
            res.send(result);
        });

        app.post('/lessons/update/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const updatedData = req.body;

                delete updatedData._id;

                const filter = { _id: new ObjectId(id) };

                const updateDoc = {
                    $set: {
                        ...updatedData,
                        updatedAt: new Date()
                    }
                };

                const result = await lessonsCollection.updateOne(filter, updateDoc);

                res.status(200).send(result);

            } catch (error) {
                console.error("Backend Update Error:", error);
                res.status(500).send({ success: false, error: error.message });
            }
        });

        app.delete('/lessons/delete/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const filter = { _id: new ObjectId(id) };
                const result = await lessonsCollection.deleteOne(filter);
                if (result.deletedCount === 1) {
                    res.status(200).send({ success: true, message: "Deleted successfully" });
                } else {
                    res.status(404).send({ success: false, message: "Lesson not found" });
                }
            } catch (error) {
                console.error("Backend Delete Error:", error);
                res.status(500).send({ success: false, error: error.message });
            }
        });

        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // await client.close();
    }
}
run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('Server is Serving...')
})

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
})