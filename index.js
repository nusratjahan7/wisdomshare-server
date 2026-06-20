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
        const savedCollection = db.collection("saved_lessons");
        const reportsCollection = db.collection("reports");
        const commentsCollection = db.collection("comments");

        // user related
        app.post('/user/profile/update/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const { name, bio, image } = req.body;

                const filter = { _id: new ObjectId(id) };
                const updateDoc = {
                    $set: {
                        name: name,
                        bio: bio,
                        image: image,
                        updatedAt: new Date()
                    }
                };

                const result = await usersCollection.updateOne(filter, updateDoc);

                if (result.modifiedCount > 0 || result.matchedCount > 0) {
                    res.status(200).send({ success: true, message: "Profile updated successfully!" });
                } else {
                    res.status(400).send({ success: false, message: "No changes made." });
                }
            } catch (error) {
                console.error("Profile Update Error:", error);
                res.status(500).send({ success: false, error: error.message });
            }
        });


        app.get('/user/stats/:id', async (req, res) => {
            try {
                const id = req.params.id;

                const lessonCount = await lessonsCollection.countDocuments({ userId: id });

                res.status(200).send({
                    totalLessons: lessonCount,
                    totalLikes: 934,
                    totalViews: "12.8k"
                });
            } catch (error) {
                console.error("Stats Fetch Error:", error);
                res.status(500).send({ success: false, error: error.message });
            }
        });

        // --- LIKE AND UNLIKE ENDPOINT ---
        app.post('/api/lessons/:id/like', async (req, res) => {
            try {
                const id = req.params.id;
                const { userId } = req.body;
                const filter = { _id: new ObjectId(id) };

                const lesson = await lessonsCollection.findOne(filter);
                if (!lesson) return res.status(404).send({ success: false, message: "Lesson not found" });

                let likesArray = lesson.likedBy || [];
                let liked = false;

                if (likesArray.includes(userId)) {
                    // Pull if already liked
                    await lessonsCollection.updateOne(filter, {
                        $pull: { likedBy: userId },
                        $inc: { totalLikes: -1 }
                    });
                } else {
                    // Push if not liked yet
                    await lessonsCollection.updateOne(filter, {
                        $push: { likedBy: userId },
                        $inc: { totalLikes: 1 }
                    });
                    liked = true;
                }

                const updatedLesson = await lessonsCollection.findOne(filter);
                res.status(200).send({
                    success: true,
                    liked,
                    totalLikes: updatedLesson.totalLikes || 0
                });
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });

        // --- SAVE LESSON ENDPOINT WITH USER PLAN RESTRICTION ---
        app.post('/api/lessons/save', async (req, res) => {
            try {
                const { lessonId, userId, userPlan } = req.body;

                // Check if already saved
                const existingSave = await savedCollection.findOne({ lessonId, userId });
                if (existingSave) {
                    return res.status(400).send({ success: false, message: "Lesson already saved!" });
                }

                // Limit validation for user_free plan
                if (userPlan === 'user_free') {
                    const count = await savedCollection.countDocuments({ userId });
                    if (count >= 5) {
                        return res.status(403).send({
                            success: false,
                            message: "Free tier limit reached! You cannot save more than 5 lessons."
                        });
                    }
                }

                const newSave = { lessonId, userId, savedAt: new Date() };
                const result = await savedCollection.insertOne(newSave);
                res.status(201).send({ success: true, result });
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });

        app.get('/api/lessons/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) }
            const result = await lessonsCollection.findOne(query);
            res.send(result);
        })

        app.get('/api/lessons', async (req, res) => {
            try {
                const query = {};


                if (req.query.search) {
                    query.$or = [
                        { title: { $regex: req.query.search, $options: 'i' } },
                        { subtitle: { $regex: req.query.search, $options: 'i' } }
                    ];
                }


                if (req.query.category && req.query.category !== 'all') {
                    query.category = { $regex: new RegExp(`^${req.query.category}$`, 'i') };
                }


                if (req.query.accessType && req.query.accessType !== 'all') {
                    query.accessType = req.query.accessType;
                }


                const page = parseInt(req.query.page) || 1;
                const perPage = parseInt(req.query.perPage) || 12;
                const skipItems = (page - 1) * perPage;

                const total = await lessonsCollection.countDocuments(query);


                const lessons = await lessonsCollection.find(query)
                    .sort({ createdAt: -1 })
                    .skip(skipItems)
                    .limit(perPage)
                    .toArray();

                res.send({ total, lessons });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });



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