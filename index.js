const express = require('express');
const dotenv = require('dotenv');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
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
        // Connect the client to the server
        await client.connect();

        const dbName = process.env.AUTH_DB_NAME || "test";
        const db = client.db(dbName);

        const usersCollection = db.collection("user");
        const lessonsCollection = db.collection("lessons");
        const savedCollection = db.collection("saved_lessons");
        const reportsCollection = db.collection("reports");
        const commentsCollection = db.collection("comments");
        const planCollection = db.collection("plans");
        const paymentCollection = db.collection("payments");

        console.log(`Connected successfully to database: ${dbName}`);

        // ==========================================
        // USER ROUTES
        // ==========================================
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

        // ==========================================
        // LESSONS & INTERACTION ROUTES
        // ==========================================
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
                    await lessonsCollection.updateOne(filter, {
                        $pull: { likedBy: userId },
                        $inc: { totalLikes: -1 }
                    });
                } else {
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

        app.post('/api/lessons/save', async (req, res) => {
            try {
                const { lessonId, userId, userPlan } = req.body;

                const existingSave = await savedCollection.findOne({ lessonId, userId });
                if (existingSave) {
                    return res.status(400).send({ success: false, message: "Lesson already saved!" });
                }

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

        app.get('/api/lessons/save-status', async (req, res) => {
            try {
                const { lessonId, userId } = req.query;
                const existing = await savedCollection.findOne({ lessonId, userId });
                res.send({ isSaved: !!existing });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.get('/api/lessons/related/:category', async (req, res) => {
            try {
                const { category } = req.params;
                const { currentId } = req.query;

                const query = {
                    category: { $regex: new RegExp(`^${category}$`, 'i') }
                };

                if (currentId && currentId !== 'undefined') {
                    query._id = { $ne: new ObjectId(currentId) };
                }

                const related = await lessonsCollection.find(query).limit(3).toArray();
                res.send(related);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.get('/api/lessons/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const query = { _id: new ObjectId(id) };
                const result = await lessonsCollection.findOne(query);
                res.send(result);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

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
            try {
                const userId = req.query.userId;
                const result = await lessonsCollection
                    .find({ userId: userId })
                    .sort({ createdAt: -1 })
                    .toArray();
                res.send(result);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.post('/lessons/add', async (req, res) => {
            try {
                const lesson = req.body;
                const newLesson = { ...lesson, createdAt: new Date() };
                const result = await lessonsCollection.insertOne(newLesson);
                res.send(result);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.post('/lessons/update/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const updatedData = req.body;
                delete updatedData._id;

                const filter = { _id: new ObjectId(id) };
                const updateDoc = {
                    $set: { ...updatedData, updatedAt: new Date() }
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

        // --- GET USER SAVED LESSONS DETAILS ---
        app.get('/my-saved-lessons', async (req, res) => {
            try {
                const userId = req.query.userId;
                if (!userId) {
                    return res.status(400).send({ success: false, message: "UserId is required" });
                }

                const savedLessons = await savedCollection.aggregate([
                    { $match: { userId: userId } },
                    {
                        $addFields: {
                            lessonObjectId: { $toObjectId: "$lessonId" }
                        }
                    },
                    {
                        $lookup: {
                            from: "lessons",
                            localField: "lessonObjectId",
                            foreignField: "_id",
                            as: "lessonDetails"
                        }
                    },
                    { $unwind: "$lessonDetails" },
                    { $sort: { savedAt: -1 } }
                ]).toArray();


                const formattedResult = savedLessons.map(item => ({
                    _id: item.lessonDetails._id,
                    title: item.lessonDetails.title,
                    subtitle: item.lessonDetails.subtitle,
                    description: item.lessonDetails.description,
                    image: item.lessonDetails.image,
                    tags: item.lessonDetails.tags || ["Reflective"],
                    accessType: item.lessonDetails.accessType,
                    isFeatured: item.lessonDetails.isFeatured,
                    authorName: item.lessonDetails.authorName,
                    authorImage: item.lessonDetails.authorImage,
                    totalLikes: item.lessonDetails.totalLikes || 0,
                    totalSaves: item.lessonDetails.totalSaves || 0
                }));

                res.status(200).send(formattedResult);
            } catch (error) {
                console.error("Fetch Saved Lessons Error:", error);
                res.status(500).send({ success: false, error: error.message });
            }
        });

        // ==========================================
        // UTILITY: REPORTS & COMMENTS
        // ==========================================
        app.post('/api/reports/add', async (req, res) => {
            try {
                const reportData = req.body;
                const result = await reportsCollection.insertOne({
                    ...reportData,
                    createdAt: new Date()
                });
                res.status(201).send({ success: true, result });
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });

        app.get('/api/comments/:lessonId', async (req, res) => {
            try {
                const lessonId = req.params.lessonId;
                const comments = await commentsCollection
                    .find({ lessonId })
                    .sort({ createdAt: -1 })
                    .limit(4)
                    .toArray();
                res.send(comments);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.post('/api/comments/add', async (req, res) => {
            try {
                const comment = req.body;
                const result = await commentsCollection.insertOne({
                    ...comment,
                    createdAt: new Date()
                });
                res.status(201).send(result);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // ==========================================
        // PLANS & SUBSCRIPTION PAYMENTS
        // ==========================================
        app.get('/api/plans', async (req, res) => {
            try {
                const query = {};
                if (req.query.plan_id) {
                    query.planId = req.query.plan_id; // Check using your dynamic unique key
                }
                const plan = await planCollection.findOne(query);
                res.send(plan);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.post('/api/payments', async (req, res) => {
            try {
                const data = req.body;
                if (!data.email || !data.planId) {
                    return res.status(400).send({ success: false, message: "Missing email or planId" });
                }

                const subInfo = {
                    ...data,
                    createdAt: new Date()
                };
                const paymentResult = await paymentCollection.insertOne(subInfo);

                // Update the user's tier assignment
                const filter = { email: data.email };
                const updateDocument = {
                    $set: { plan: data.planId }
                };
                const userUpdateResult = await usersCollection.updateOne(filter, updateDocument);

                // Return clean structural JSON to prevent Next.js parsing crashes
                res.status(200).send({
                    success: true,
                    message: "Payment tracked and user plan upgraded.",
                    paymentResult,
                    userUpdateResult
                });
            } catch (error) {
                console.error("Payment API Error:", error);
                res.status(500).send({ success: false, error: error.message });
            }
        });

        // Ping confirmation
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");

    } catch (err) {
        console.error("Failed to start server configurations:", err);
    }
}

run().catch(console.dir);

app.get('/', (req, res) => {
    res.send('Server is Serving...')
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`)
});