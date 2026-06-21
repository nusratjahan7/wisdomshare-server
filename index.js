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

        const featuredCollection = db.collection("featured");

        console.log(`Connected successfully to database: ${dbName}`);


        // ==========================================
        // ADMIN: USER MANAGEMENT ROUTES
        // ==========================================
        app.get('/api/admin/analytics-overview', async (req, res) => {
            try {
                const totalUsers = await usersCollection.countDocuments({});
                const publishedLessons = await lessonsCollection.countDocuments({ status: "Reviewed" });
                const premiumMembers = await usersCollection.countDocuments({ plan: { $ne: "user_free" } });
                const reportedContent = await reportsCollection.countDocuments({});

                // ফিক্সড পাইপলাইন: প্রথমে চেক করা হচ্ছে ফিল্ডটি খালি কিনা, তারপর সেটিকে ডেট অবজেক্টে রূপান্তর করা হচ্ছে
                const monthlyGrowthPipeline = [
                    {
                        $addFields: {
                            // যদি createdAt ফিল্ডটি থাকে, তবে তাকে ডেট অবজেক্ট বানাবে, নাহলে কারেন্ট ডেট অবজেক্ট বসাবে
                            validDate: {
                                $cond: {
                                    if: { $and: [{ $not: [{ $not: ["$createdAt"] }] }, { $ne: ["$createdAt", null] }] },
                                    then: { $toDate: "$createdAt" },
                                    else: new Date()
                                }
                            }
                        }
                    },
                    {
                        $group: {
                            // এখন "$createdAt"-এর বদলে রূপান্তরিত "$validDate" ব্যবহার করা হয়েছে
                            _id: { $month: "$validDate" },
                            count: { $sum: 1 }
                        }
                    },
                    { $sort: { "_id": 1 } }
                ];

                const userGrowthRaw = await usersCollection.aggregate(monthlyGrowthPipeline).toArray();
                const lessonGrowthRaw = await lessonsCollection.aggregate(monthlyGrowthPipeline).toArray();

                const monthsMap = { 1: "Jan", 2: "Feb", 3: "Mar", 4: "Apr", 5: "May", 6: "Jun" };

                const growthChartData = Object.keys(monthsMap).map(mMonth => {
                    const monthNum = parseInt(mMonth);
                    const userMonth = userGrowthRaw.find(d => d._id === monthNum);
                    const lessonMonth = lessonGrowthRaw.find(d => d._id === monthNum);

                    return {
                        month: monthsMap[monthNum],
                        users: userMonth ? userMonth.count : 0,
                        lessons: lessonMonth ? lessonMonth.count : 0
                    };
                });

                const categoryPipeline = [
                    {
                        $group: {
                            _id: "$category",
                            count: { $sum: 1 }
                        }
                    },
                    { $sort: { count: -1 } }
                ];
                const rawCategories = await lessonsCollection.aggregate(categoryPipeline).toArray();

                const lessonsByCategory = rawCategories.map(cat => ({
                    category: cat._id || "Other",
                    count: cat.count
                }));

                const startOfToday = new Date();
                startOfToday.setHours(0, 0, 0, 0);

                // আজকের লেসন কাউন্টের কোয়েরিকেও স্ট্রিং বা ডেট অবজেক্ট দুই ফরম্যাটের জন্যই নিরাপদ করা হলো
                const todaysLessonsCount = await lessonsCollection.countDocuments({
                    $or: [
                        { createdAt: { $gte: startOfToday } },
                        { createdAt: { $gte: startOfToday.toISOString() } } // যদি ডাটাবেজে ISO String থাকে
                    ]
                });

                res.status(200).send({
                    cards: {
                        totalUsers,
                        publishedLessons,
                        premiumMembers,
                        reportedContent,
                        todaysLessons: todaysLessonsCount
                    },
                    growthChartData,
                    lessonsByCategory
                });

            } catch (error) {
                console.error("Admin Analytics Fetch Error:", error);
                res.status(500).send({ success: false, error: error.message });
            }
        });

        app.get('/api/admin/users', async (req, res) => {
            try {
                const allUsers = await usersCollection.find({}).toArray();
                const formattedUsers = await Promise.all(allUsers.map(async (user) => {
                    const userIdString = user._id.toString();
                    const count = await lessonsCollection.countDocuments({ userId: userIdString });

                    return {
                        _id: user._id,
                        name: user.name,
                        email: user.email,
                        joined: user.createdAt || "N/A",
                        plan: user.plan || "user_free",
                        status: user.status || "Active",
                        role: user.role || "user",
                        lessons: count
                    };
                }));

                res.status(200).send(formattedUsers);
            } catch (error) {
                console.error("Fetch All Users Error:", error);
                res.status(500).send({ success: false, error: error.message });
            }
        });

        app.patch('/api/admin/users/update-role/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const { role } = req.body;

                if (!role) {
                    return res.status(400).send({ success: false, message: "Role is required" });
                }

                const filter = { _id: new ObjectId(id) };
                const updateDoc = {
                    $set: {
                        role: role,
                        updatedAt: new Date()
                    }
                };

                const result = await usersCollection.updateOne(filter, updateDoc);

                if (result.modifiedCount > 0 || result.matchedCount > 0) {
                    res.status(200).send({ success: true, message: `User role updated to ${role} successfully!` });
                } else {
                    res.status(400).send({ success: false, message: "No changes made." });
                }
            } catch (error) {
                console.error("Role Update Error:", error);
                res.status(500).send({ success: false, error: error.message });
            }
        });

        app.delete('/api/admin/users/delete/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const filter = { _id: new ObjectId(id) };

                const result = await usersCollection.deleteOne(filter);

                if (result.deletedCount === 1) {
                    res.status(200).send({ success: true, message: "User account deleted successfully!" });
                } else {
                    res.status(404).send({ success: false, message: "User not found" });
                }
            } catch (error) {
                console.error("User Delete Error:", error);
                res.status(500).send({ success: false, error: error.message });
            }
        });


        // ==========================================
        // ADMIN: LESSON MODERATION ROUTES
        // ==========================================
        app.get('/api/admin/lessons', async (req, res) => {
            try {
                const allLessons = await lessonsCollection.find({}).sort({ createdAt: -1 }).toArray();

                const formattedLessons = allLessons.map(lesson => ({
                    _id: lesson._id,
                    title: lesson.title,
                    createdAt: lesson.createdAt || "N/A",
                    username: lesson.username || "Unknown Author",
                    category: lesson.category || "General",
                    access: lesson.accessType || "Free",
                    isFeatured: lesson.isFeatured || false,
                    status: lesson.status || "Pending",
                    image: lesson.image || ""
                }));

                res.status(200).send(formattedLessons);
            } catch (error) {
                console.error("Fetch All Lessons Admin Error:", error);
                res.status(500).send({ success: false, error: error.message });
            }
        });


        app.patch('/api/admin/lessons/featured/:id', async (req, res) => {
            const { id } = req.params;
            const { isFeatured, ...fullLessonData } = req.body; // ফ্রন্টএন্ড থেকে পাঠানো সম্পূর্ণ ডাটা এবং ফ্ল্যাগ রিসিভ করা হলো

            try {
                // ১. মূল lessons কালেকশনে ফিউচার্ড স্ট্যাটাস আপডেট করা
                await lessonsCollection.updateOne(
                    { _id: new ObjectId(id) },
                    { $set: { isFeatured: isFeatured, updatedAt: new Date() } }
                );

                if (isFeatured) {
                    // ২. যদি Featured ট্রু হয়, তবে সম্পূর্ণ ডাটা সহ featured কালেকশনে Upsert করুন
                    // ফ্রন্টএন্ড থেকে আসা অবজেক্টে আইডি থাকলে তা বাদ দিয়ে মূল আইডি সেট করছি
                    delete fullLessonData._id;

                    await featuredCollection.updateOne(
                        { lessonId: new ObjectId(id) },
                        {
                            $set: {
                                lessonId: new ObjectId(id),
                                ...fullLessonData,
                                addedAt: new Date()
                            }
                        },
                        { upsert: true }
                    );
                } else {
                    // ৩. যদি Featured ফলস হয়, তবে featured কালেকশন থেকে রিমুভ করে দিন
                    await featuredCollection.deleteOne({ lessonId: new ObjectId(id) });
                }

                res.status(200).send({ success: true, message: `Featured status updated to ${isFeatured}` });
            } catch (error) {
                console.error("Featured Update Error:", error);
                res.status(500).send({ success: false, error: error.message });
            }
        });

        app.patch('/api/admin/lessons/reviewed/:id', async (req, res) => {
            try {
                const id = req.params.id;
                const filter = { _id: new ObjectId(id) };
                const updateDoc = {
                    $set: {
                        status: "Reviewed",
                        updatedAt: new Date()
                    }
                };

                const result = await lessonsCollection.updateOne(filter, updateDoc);
                if (result.modifiedCount > 0 || result.matchedCount > 0) {
                    res.status(200).send({ success: true, message: "Lesson marked as reviewed!" });
                } else {
                    res.status(400).send({ success: false, message: "No changes made." });
                }
            } catch (error) {
                res.status(500).send({ success: false, error: error.message });
            }
        });


        app.get('/api/lessons/featured', async (req, res) => {
            try {
                const featuredLessons = await lessonsCollection
                    .find({ isFeatured: true })
                    .sort({ updatedAt: -1 })
                    .limit(6)
                    .toArray();

                res.send(featuredLessons);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

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

        app.get('/api/user-dashboard', async (req, res) => {
            try {
                const userId = req.query.userId;
                if (!userId) {
                    return res.status(400).send({ error: "User ID is required" });
                }

                const totalLessons = await lessonsCollection.countDocuments({ userId: userId });

                const statsPipeline = [
                    { $match: { userId: userId } },
                    {
                        $group: {
                            _id: null,
                            totalLikes: { $sum: { $cond: { if: { $isArray: "$likedBy" }, then: { $size: "$likedBy" }, else: 0 } } },
                            totalViews: { $sum: { $ifNull: ["$views", 0] } }
                        }
                    }
                ];
                const statsResult = await lessonsCollection.aggregate(statsPipeline).toArray();
                const totalLikes = statsResult[0]?.totalLikes || 0;
                const totalViews = statsResult[0]?.totalViews || 0;

                const userLessons = await lessonsCollection.find({ userId: userId }, { projection: { _id: 1 } }).toArray();
                const userLessonIds = userLessons.map(lesson => lesson._id.toString());

                const totalSaves = await db.collection("saved_lessons").countDocuments({
                    lessonId: { $in: userLessonIds }
                });

                const graphDataPipeline = [
                    { $match: { userId: userId } },
                    {
                        $group: {
                            _id: { $month: "$createdAt" },
                            lessonsCount: { $sum: 1 },
                            likesCount: { $sum: { $cond: { if: { $isArray: "$likedBy" }, then: { $size: "$likedBy" }, else: 0 } } }
                        }
                    },
                    { $sort: { "_id": 1 } }
                ];
                const rawGraphData = await lessonsCollection.aggregate(graphDataPipeline).toArray();

                const monthsMap = { 1: "Jan", 2: "Feb", 3: "Mar", 4: "Apr", 5: "May", 6: "Jun" };
                const graphData = Object.keys(monthsMap).map(mMonth => {
                    const monthNum = parseInt(mMonth);
                    const found = rawGraphData.find(d => d._id === monthNum);
                    return {
                        month: monthsMap[monthNum],
                        lessons: found ? found.lessonsCount : 0,
                        likes: found ? found.likesCount : 0
                    };
                });

                res.send({
                    totalLessons,
                    totalViews,
                    totalLikes,
                    totalSaves,
                    graphData
                });
            } catch (error) {
                res.status(500).send({ error: error.message });
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

                const lessons = await lessonsCollection.aggregate([
                    { $match: query },
                    { $sort: { createdAt: -1 } },
                    { $skip: skipItems },
                    { $limit: perPage },
                    {
                        $lookup: {
                            from: "saved_lessons",
                            let: { lesson_id: { $toString: "$_id" } },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: { $eq: ["$lessonId", "$$lesson_id"] }
                                    }
                                }
                            ],
                            as: "savedDocs"
                        }
                    },
                    {
                        $addFields: {
                            totalSaves: { $size: "$savedDocs" },
                            totalLikes: {
                                $cond: {
                                    if: { $isArray: "$likedBy" },
                                    then: { $size: "$likedBy" },
                                    else: 0
                                }
                            }
                        }
                    },
                    {
                        $project: {
                            savedDocs: 0
                        }
                    }
                ]).toArray();

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
        app.get('/api/admin/reports', async (req, res) => {
            try {
                const reports = await reportsCollection.aggregate([
                    {
                        $group: {
                            _id: "$lessonId",
                            lessonTitle: { $first: "$lessonTitle" },
                            reportCount: { $sum: 1 },
                            reports: { $push: "$$ROOT" }
                        }
                    }
                ]).toArray();

                res.send(reports);
            } catch (error) {
                res.status(500).send({
                    success: false,
                    error: error.message
                });
            }
        });

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

        app.delete('/api/admin/reports/ignore/:lessonId', async (req, res) => {
            try {
                const { lessonId } = req.params;

                await reportsCollection.deleteMany({
                    lessonId
                });

                res.send({
                    success: true,
                    message: "Reports cleared"
                });

            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.delete('/api/admin/reports/delete-lesson/:lessonId', async (req, res) => {
            try {
                const { lessonId } = req.params;

                await lessonsCollection.deleteOne({
                    _id: new ObjectId(lessonId)
                });

                await reportsCollection.deleteMany({
                    lessonId
                });

                res.send({
                    success: true
                });

            } catch (error) {
                res.status(500).send({ error: error.message });
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
                    query.planId = req.query.plan_id;
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

                const filter = { email: data.email };
                const updateDocument = {
                    $set: { plan: data.planId }
                };
                const userUpdateResult = await usersCollection.updateOne(filter, updateDocument);

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


        // ==========================================
        // Top Contributor
        // ==========================================
        app.get('/api/top-contributors', async (req, res) => {
            try {
                const topContributors = await usersCollection.aggregate([
                    {
                        $lookup: {
                            from: "lessons",
                            let: { user_id: { $toString: "$_id" } },
                            pipeline: [
                                {
                                    $match: {
                                        $expr: { $eq: ["$userId", "$$user_id"] }
                                    }
                                }
                            ],
                            as: "userLessons"
                        }
                    },
                    {
                        $addFields: {
                            lessonCount: { $size: "$userLessons" }
                        }
                    },
                    { $sort: { lessonCount: -1 } },
                    { $limit: 3 },
                    {
                        $project: {
                            name: 1,
                            image: 1,
                            title: 1,
                            lessonCount: 1
                        }
                    }
                ]).toArray();

                res.send(topContributors);
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

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