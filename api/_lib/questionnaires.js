// The ready-made questionnaires behind Setup's "Go deeper" screens.
//
// One catalogue, read by the server (to check what is saved) and sent to the page (to draw it).
// Each questionnaire sits on one Setup step. People can answer it on the page, download it as a
// document to fill in or send to someone, or upload a document they already have.
//
//   id        fixed: the build reads answers by it
//   step      which Setup step shows it (1 webinar, 2 audience, 3 offer and proof, 4 tools, 5 look)
//   who       'you' the owner answers · 'client' it is meant to be sent to one of their clients
//   repeat    how many copies can be filled in (one per client, for case studies)
//   files     what is worth uploading alongside it, in the owner's words
//   sections  [title, [[question id, question, hint?, type?, options?], ...]]
//             type: 'long' (default) · 'short' · 'ticks' (options to tick)
//
// Question ids never change once shipped. Add new ones at the end of a section.

const RAW = [
  // ── Step 1: your webinar ───────────────────────────────────────────────────
  {
    id: 'webinar_plan', step: 1, title: 'Your webinar plan', minutes: 15, who: 'you',
    blurb: 'What the webinar is for, what you will teach and how it ends. This shapes the script, the sign-up page and every reminder.',
    files: 'Slides, a script or a recording from a webinar you have already run.',
    sections: [
      ['The goal', [
        ['goal', 'What do you want this webinar to do for your business?', 'For example: 20 booked calls a month, or 10 sales of the programme.'],
        ['numbers', 'What numbers would make you happy?', 'Sign-ups, people who turn up, calls booked and sales. A rough guess is fine.'],
        ['history', 'Have you run a webinar before? What happened?', 'How many signed up, how many came, how many bought, and what you think went wrong or right.'],
      ]],
      ['What you will teach', [
        ['promise', 'In one sentence, what will someone understand or be able to do by the end?'],
        ['three_things', 'What are the three main things you will teach?', 'One line each. These become the bullet points on your sign-up page.'],
        ['myth', 'What is the biggest myth or mistake you will put right?', 'The thing most people in your market believe that is holding them back.'],
        ['belief', 'What does someone need to believe by the end to want your offer?', 'For example: that it is possible for them, that the old way is why they are stuck, that they need help to do it.'],
        ['length', 'How long will it run, and will you take questions?', 'For example: 60 minutes of teaching, then 20 minutes of questions.'],
      ]],
      ['How it ends', [
        ['cta', 'What exactly do you want people to do at the end?', 'Book a call, buy on the spot, apply, or something else.'],
        ['reason_now', 'Is there a real reason to act straight away?', 'A bonus for people who came live, a deadline, or a limit on places. Only list ones that are true.'],
        ['replay', 'Will there be a replay? For how long?', 'For example: yes, for 48 hours. Or no, live only.'],
      ]],
      ['Getting people there', [
        ['traffic', 'Where will your sign-ups come from?', 'Paid ads, your email list, social media, partners, or a mix.'],
        ['audience_size', 'How big is your email list and your social following today?'],
        ['ad_budget', 'How much can you spend on ads each month?', 'Include the currency. Say none if you are not running ads.'],
        ['guests', 'Will anyone else be on the webinar with you?', 'A guest, a client telling their story, or someone answering questions in the chat.'],
      ]],
    ],
  },
  {
    id: 'origin_story', step: 1, title: 'Your story', minutes: 30, who: 'you',
    blurb: 'Where you came from and why you do this. It becomes the "about your host" part of the page and the opening of the webinar.',
    files: 'An "about me" page, a bio, or a recording of you telling your story.',
    sections: [
      ['You right now', [
        ['day', 'What does your day-to-day life actually look like?', 'For example: up at 6, gym, desk by 9, calls in the morning, pick the kids up at 3:30.'],
        ['described', 'How would the people closest to you describe you?'],
        ['proud', 'What are you most proud of right now, personally, not professionally?'],
        ['improving', 'What are you currently trying to get better at?'],
      ]],
      ['Growing up', [
        ['home', 'Where did you grow up, and what was home like?', 'The place, the household, the feel of it.'],
        ['parents', 'What did you learn about work and money from watching your parents?', 'Not what they told you. What you picked up from how they lived.'],
        ['kid', 'What were you like as a child?'],
        ['shaped', 'Was there a moment from your early life that really shaped you?', 'A person, an event, a loss, something that stuck.'],
      ]],
      ['The journey to here', [
        ['work_history', 'Walk through your work history, and what you took from each job or business.', 'From your first job to now.'],
        ['realised', 'When did you first realise you wanted to help people for a living?'],
        ['started', 'How did your current business actually start?'],
        ['pivots', 'How has your business changed since you started?', 'What you tried that did not work, and what you changed.'],
      ]],
      ['The hard parts', [
        ['lowest', 'What is the lowest point you have been through?', 'Be as specific as you are comfortable with.'],
        ['kept_going', 'How long did it last, and what kept you going?'],
        ['taught', 'What did that period teach you?'],
      ]],
      ['The breakthrough', [
        ['shift', 'What changed? What turned things around?'],
        ['before_after', 'Who were you before, and who are you now?'],
        ['own_results', 'What results have you had from your own change?', 'Numbers, milestones, proof.'],
      ]],
      ['What you believe', [
        ['disagree', 'What do you believe about your industry that most people would disagree with?'],
        ['stand_for', 'What do you stand for, and what do you stand against?'],
        ['influences', 'Who or what has shaped your thinking the most?', 'Three to five people, books or experiences.'],
        ['one_thing', 'If you could only teach one thing for the rest of your life, what would it be?'],
      ]],
      ['Looking forward', [
        ['future', 'Where do you see your life and business in three to five years?'],
        ['legacy', 'What do you want to be remembered for?'],
        ['advice', 'What would you say to yourself at the very start of this journey?'],
        ['anything_else', 'Is there anything about your story that matters and we have not asked?'],
      ]],
    ],
  },
  {
    id: 'brand_voice', step: 1, title: 'How you speak', minutes: 10, who: 'you',
    blurb: 'We write in your voice, not a generic one. To do that we need to read how you really talk. Three to five pieces is enough.',
    files: 'Written-out recordings of you talking: podcasts, videos, webinars, sales calls or voice notes. Do not tidy them up. Filler words and half sentences are what make it sound like you.',
    sections: [
      ['Where we can hear you', [
        ['sources', 'Paste links to anything where you are talking naturally.', 'Podcast episodes, YouTube videos, reels, a past webinar, a recorded call. One per line.'],
        ['best', 'Which one is you at your best?', 'We will lean on that one the most.'],
        ['transcript', 'Or paste the words from one recording here.', 'Free tools such as TurboScribe or Otter turn a recording into text. On YouTube, open the video and choose "Show transcript".'],
      ]],
      ['Your words', [
        ['phrases', 'What phrases or sayings do you use all the time?'],
        ['never', 'What words or phrases would you never use?', 'Anything that makes you wince when you read it.'],
        ['tone', 'How would you describe the way you talk to your audience?', 'For example: straight talking, warm, a bit cheeky, never salesy.'],
      ]],
    ],
  },

  // ── Step 2: your audience ──────────────────────────────────────────────────
  {
    id: 'ideal_client', step: 2, title: 'Your ideal client, in depth', minutes: 40, who: 'you',
    blurb: 'A full picture of the person this webinar is for: who they are, what hurts, what they want and why they hold back. Every headline, email and ad is written from this.',
    files: 'Anything you already have on your ideal client: a profile, survey answers, call notes, or messages from clients in their own words.',
    sections: [
      ['In one line', [
        ['one_line', 'In one sentence, describe your perfect client.', 'Who they are, the pain they have, the change they want, and what they must be willing to do. For example: busy gym owners turning over 20k a month who want more members without doing more sales calls.'],
        ['role', 'What do they do? What kind of business or job?'],
        ['stage', 'Where are they right now?', 'Their income or turnover, how long they have been going, the stage they are stuck at.'],
        ['only_one', 'If you could only work with one type of person for the next year, who would it be and why?'],
      ]],
      ['Who fits and who does not', [
        ['must_have', 'What must be true of someone for you to be able to help them?', 'For example: already has paying clients, earns above a certain amount, has time each week to do the work.'],
        ['region', 'Where do they need to live, and what language do they need to speak?', 'This also sets where your ads run and what time the webinar is on.'],
        ['nice_to_have', 'What makes someone an even better fit, without being essential?', 'Three things.'],
        ['disqualify', 'What rules someone out straight away?', 'Three things. For example: no money to invest, wants results overnight, no clients yet.'],
        ['bad_traits', 'What attitudes or behaviour tell you someone will be a difficult client?'],
        ['filter', 'How should we keep the wrong people out?', 'For example: a question on the booking form, saying the price up front, or saying plainly who it is not for.'],
      ]],
      ['What goes on in their head', [
        ['identity', 'How do they see themselves?', 'For example: someone who left a good job to go it alone and is determined to prove it was the right call.'],
        ['motivation', 'What really drives them?', 'Freedom, money, status, making a difference, security, being their own boss. Say which, and why.'],
        ['pain_practical', 'What is their biggest problem right now, in practical terms?'],
        ['pain_emotional', 'What does that problem cost them emotionally?', 'What they lie awake thinking about. What it does to their confidence, their family, their health.'],
        ['tried', 'What have they already tried, and why did it not work?', 'Courses, coaches, free videos, doing it alone. Say what was missing each time.'],
        ['dream', 'What does their dream look like?', 'Income, lifestyle, what a normal day looks like, who is around them.'],
      ]],
      ['Before and after', [
        ['results_before_after', 'What do their results look like before working with you, and after?', 'Income, leads, clients, or whatever you measure. Give both.'],
        ['identity_before_after', 'How do they see themselves before, and after?'],
        ['day_before_after', 'What does a normal day look like before, and after?', 'Hours worked, what they spend time on, how much energy they have.'],
        ['proof_metric', 'What is the one number you use to show it worked?', 'For example: monthly income, new clients a month, hours worked a week.'],
        ['cost_of_waiting', 'What does it cost them to stay as they are?', 'In money, time or stress. For example: every month they wait is another 10k they did not earn.'],
        ['time_to_result', 'How soon can they realistically expect a first result, and the full result?'],
      ]],
      ['How your offer fits', [
        ['top_wants', 'List the top five things they want or want rid of.', 'One per line, in their words.'],
        ['offer_answers', 'For each of those, which part of your offer deals with it, and what proof do you have?', 'A screenshot, a number or a client story for each one if you can.'],
      ]],
      ['Why they hesitate', [
        ['objections', 'What are the top five reasons people give for not going ahead?', 'In their exact words. For example: "I need to think about it", "I have been burned before".'],
        ['hidden_fear', 'For each one, what is the real fear underneath?', 'For example: "I need to think about it" usually means "I do not trust myself to follow through".'],
        ['answer', 'For each one, what do you say that puts their mind at rest?'],
      ]],
      ['Where to find them', [
        ['platforms', 'Where do they spend the most time online?', 'Your top three, and why.'],
        ['content', 'What kind of thing do they watch, read or follow there?', 'Names of people, pages, podcasts or groups help us aim your ads.'],
        ['current_route', 'How do people find you and become clients today?', 'Each step, from first hearing of you to paying.'],
        ['anything_else', 'Is there anything about your ideal client that we have not asked?'],
      ]],
    ],
  },

  // ── Step 3: your offer and proof ───────────────────────────────────────────
  {
    id: 'offer', step: 3, title: 'Your offer, in depth', minutes: 45, who: 'you',
    blurb: 'Everything inside what you sell, how it works and what it delivers. The closing part of your webinar and the follow-up emails are built from this.',
    files: 'A sales page, a brochure, a proposal, a welcome pack, or a recording of you explaining the offer on a call.',
    sections: [
      ['The offer', [
        ['name_format', 'What is it called, and what form does it take?', 'One to one, group, a course, a membership, done for you, or a mix.'],
        ['walk_away', 'In one or two sentences, what does someone walk away with?'],
        ['price', 'What does it cost? Include any payment plans and the currency.'],
      ]],
      ['How it is put together', [
        ['structure', 'Walk through the whole thing from start to finish. What are the stages called?'],
        ['each_stage', 'For each stage, what does the client learn, do and come away with?'],
        ['journey', 'What does it look like week by week or month by month?', 'For example: week 1 they watch the first videos and fill in the workbook. Week 2 they join their first group call.'],
        ['live', 'What live calls or sessions are included?', 'How often, how long, one to one or group, and what happens on them.'],
        ['recorded', 'Is there recorded content? Roughly how much, and is it all there from day one?'],
      ]],
      ['What they get to use', [
        ['resources', 'List every tool, template, script, workbook or checklist that is included.'],
        ['resources_use', 'For each one, what does it do and when does the client use it?'],
        ['frameworks', 'Have you created any named methods, diagrams or models?', 'Describe each one: what it is, what it explains, how clients use it.'],
      ]],
      ['Your method', [
        ['method_name', 'Does your method have a name?', 'If not, just describe how it works. There is a separate questionnaire that goes deep on this.'],
        ['method_steps', 'What are the steps? For each, what does the client do and what changes?'],
        ['core_idea', 'What is the main idea that makes it work?'],
        ['why_works', 'Why does your way work when other ways do not?'],
      ]],
      ['Everything included', [
        ['stack', 'List every single thing someone gets when they join, and what each would cost on its own.', 'For example: 12 weeks of group coaching, worth 6,000. Message scripts pack, worth 500.'],
        ['bonuses', 'What bonuses are included? What problem does each one solve?'],
        ['guarantee', 'Do you offer a guarantee? What are the exact terms and wording?', 'Say none if you do not. We will never invent one.'],
      ]],
      ['Results', [
        ['average_result', 'What result does the average client get?', 'Numbers, how long it takes, what changes.'],
        ['best_result', 'What is your best result ever?', 'Name, numbers, how long it took.'],
        ['first_result', 'How long until a client sees their first real result?'],
        ['stories', 'Give three to five client stories.', 'For each: where they started, what they did, where they ended up. There is a separate questionnaire you can send to each client.'],
        ['most_valuable', 'What do your best clients say is the most valuable part?'],
      ]],
      ['After they join', [
        ['first_48', 'What happens in the first 24 to 48 hours after someone pays?', 'Welcome email, first call, access, community. What they see and do on day one.'],
        ['milestones', 'What are the big moments a client hits, and roughly when?'],
      ]],
    ],
  },
  {
    id: 'method', step: 3, title: 'What makes your method different', minutes: 60, who: 'you',
    blurb: 'Why your way works when everything else your clients tried did not. This is the heart of the webinar: the part that makes people think "that is why it never worked for me".',
    files: 'A diagram of your method, training slides, or a recording of you teaching it.',
    sections: [
      ['The problem', [
        ['core_problem', 'What is the main problem your method solves?', 'Say it the way your clients would, in their words.'],
        ['life_with_it', 'What is life like for someone living with this problem?', 'Day to day, emotionally, practically and financially.'],
        ['tried_before', 'What have people usually tried before they find you?', 'List every common approach.'],
        ['why_failed', 'For each of those, why did it not work?', 'What was missing or broken about it.'],
      ]],
      ['How you found it', [
        ['discovery', 'How did you come up with your method?', 'One breakthrough, or bit by bit over time? Walk through it.'],
        ['moment', 'Was there a moment when it clicked?', 'Where you were, what happened, what changed.'],
      ]],
      ['The method itself', [
        ['name', 'Does it have a name? If not, describe it and we will name it together.'],
        ['steps', 'Walk through every step in order.', 'For each: its name, what the client does, and what changes.'],
        ['connect', 'How do the steps connect? What happens if someone skips one?'],
        ['linchpin', 'Which one step holds everything else together?', 'The part that, if you took it out, the whole thing would stop working.'],
      ]],
      ['The big idea', [
        ['insight', 'What is the single most important idea behind your method?', 'If you could only teach one thing from it.'],
        ['surprising', 'What is surprising about it?', 'How does it go against what people have been told?'],
        ['think_before_after', 'What do people believe before they understand it, and what do they believe after?'],
      ]],
      ['Why it works', [
        ['logic', 'In your own words, why does your method get results?'],
        ['for_the_stuck', 'Why does it work for people who have failed with everything else?'],
      ]],
      ['Why it is different', [
        ['competitors', 'Name two to four well known competitors or approaches. What does each one teach?'],
        ['different', 'What do you do that nobody else does, or do in a completely different way?'],
        ['cannot_copy', 'What can your competitors not copy, even if they wanted to?'],
      ]],
      ['The old way and the new way', [
        ['old_way', 'What is the old way of solving this problem that most people still follow?'],
        ['new_way', 'What is the new way that your method stands for?'],
        ['most_think', 'Finish this: "Most people think the answer is ___. But the real answer is ___."'],
      ]],
      ['Proof', [
        ['how_many', 'How many clients have used this method, and over how long?'],
        ['in_action', 'Give two or three client stories that show the method working.', 'Where they started, what they did, what changed.'],
      ]],
      ['Explaining it simply', [
        ['dinner_party', 'How would you explain your method to a stranger at a dinner party?', 'No special words. The plain version.'],
        ['its_like', 'Finish this: "It is like ___ but for ___."', 'A comparison from cooking, sport, medicine, building, anything that makes it click.'],
      ]],
      ['Naming it', [
        ['kind', 'Is it a system, a method, a process, a blueprint, or something else? Why?'],
        ['feeling', 'What should someone think or feel when they hear its name?'],
        ['honest_line', 'In one honest sentence, what makes it different?'],
        ['why_matters', 'Why does it really matter?', 'Not the logical answer. The one that makes someone feel something.'],
        ['reason_fail', 'Finish this: "The reason most people fail at ___ is not ___. It is ___. And the answer is not ___. It is ___."'],
      ]],
    ],
  },
  {
    id: 'case_study', step: 3, title: 'A client success story', minutes: 20, who: 'client', repeat: 5,
    blurb: 'One for each of your best clients. Send it to them to fill in, or go through it together on a call. Real stories with real numbers are the most convincing thing in your whole webinar.',
    files: 'Proof for this client: a screenshot of their results, a message they sent you, a photo, or the form they filled in.',
    sections: [
      ['About them', [
        ['client_name', 'Client name, and how they would like to be credited.', 'For example: Sarah M., London. Or first name only.', 'short'],
      ]],
      ['Before', [
        ['before', 'What did life or business look like in the three to six months before starting?', 'Money, mood, and what they believed was possible. The more detail the better.'],
        ['tried', 'What had they already tried? What did they believe then that they now know is wrong?'],
      ]],
      ['The decision', [
        ['trigger', 'What made them sign up when they did? And what almost stopped them?', 'The doubts and fears that went through their mind.'],
        ['why_you', 'Why you, and not another coach, course or free content?'],
      ]],
      ['The work', [
        ['hardest', 'What was the hardest part of the first 30 to 60 days, and what was the moment it clicked?'],
        ['uncomfortable', 'What is one thing you had them do that felt uncomfortable at the time, but worked?'],
      ]],
      ['The results', [
        ['numbers', 'The numbers, before and after, with dates.', 'Monthly income, profit, number of clients, hours worked a week, or whatever fits. For example: income 3k a month in January, 11k a month by May.'],
        ['numbers_context', 'Anything else we should know about those numbers?', 'Ad spend, costs, help they had, savings they started with.'],
        ['moment', 'The exact moment they realised it was working. Where were they, and how did it feel?'],
        ['can_now', 'What can they do, buy or walk away from now that they could not six months ago?'],
      ]],
      ['Now', [
        ['new_you', 'Who are they now that they were not six months ago?'],
        ['on_the_fence', 'What would they say to someone who is still deciding?'],
        ['perfect_for', 'Who is this perfect for, and who is it not for?'],
        ['one_sentence', 'In one sentence, what did you actually do for them?'],
      ]],
      ['Permission', [
        ['permission', 'What has the client agreed to?', 'Only tick what they have really said yes to. We will not use a name or a result without it.', 'ticks', [
          'We can use their name, photo, words and numbers in our marketing',
          'What they have shared is true and accurate',
          'They understand a standard results disclaimer can run alongside their story',
          'They have not been paid or rewarded for this',
          'Happy to record a short video',
          'Happy to be interviewed live or on a call',
          'Happy to share their screen and show their results on a webinar',
        ]],
        ['rewarded', 'If they were paid or rewarded in any way, say how.', 'A discount, free access or commission must be declared.', 'short'],
      ]],
    ],
  },
  {
    id: 'proof', step: 3, title: 'Your results and proof', minutes: 15, who: 'you',
    blurb: 'Every testimonial, screenshot and video you have. Send everything, however rough or old. We will sort through it. Start with the strongest: videos, then before and after numbers, then messages.',
    files: 'Screenshots of results, payment notifications, messages and reviews from clients. Check each is readable and blank out anything private such as account numbers. Videos are too big to upload here, so paste a link to them instead.',
    sections: [
      ['What you have', [
        ['have', 'Which of these do you have?', 'Tick all that apply.', 'ticks', [
          'Video testimonials',
          'Before and after screenshots with real numbers',
          'Written case studies',
          'Messages from clients sharing a win',
          'Payment or sale screenshots',
          'Reviews on Google, Trustpilot or similar',
          'Posts where clients mention you',
          'Nothing yet',
        ]],
        ['list', 'List what you are sending, one per line.', 'Client name, what it is, and the file name or link. For example: Sarah Jones, video testimonial, link below.'],
      ]],
      ['Links', [
        ['folder', 'Paste a link to the folder where everything is.', 'A Google Drive or Dropbox folder that we can open. Name files like this: SarahJones_Testimonial_March.', 'short'],
        ['videos', 'Links to video testimonials and clients talking to camera.', 'One per line.'],
        ['interviews', 'Links to interviews, podcasts or recorded calls with clients.', 'One per line.'],
      ]],
      ['Your track record', [
        ['clients_served', 'How many clients have you worked with in total?', '', 'short'],
        ['years', 'How many years have you been doing this?', '', 'short'],
        ['press', 'Have you been featured anywhere, or won any awards or qualifications?', 'Names of publications, podcasts, awards and certificates.'],
      ]],
      ['If you have no proof yet', [
        ['plan', 'Which two or three clients could you ask this week?', 'Send each one the client success story questionnaire. Most happy clients are glad to help. They just need to be asked.'],
      ]],
    ],
  },
  {
    id: 'rules', step: 3, title: 'Rules we must keep to', minutes: 10, who: 'you',
    blurb: 'What you can and cannot say. We check every page, email and ad against this before you see it, so you never have to worry about a claim you cannot back up.',
    files: 'Any rules from your industry body, a disclaimer you already use, or your terms and privacy policy.',
    sections: [
      ['Your industry', [
        ['regulated', 'Is your industry regulated? By whom?', 'For example: financial advice, health, law, property, investing. Say no if it is not.'],
        ['must_say', 'Is there anything you are required to say?', 'A disclaimer, a risk warning, a registration number.'],
        ['never_say', 'What are you not allowed to say, or never want to say?', 'Words, claims or promises. For example: never say "guaranteed", no income promises.'],
      ]],
      ['Claims and numbers', [
        ['claims', 'Which results and numbers can you prove if asked?', 'We only use numbers you can back up with a screenshot or a record.'],
        ['typical', 'Are your best results typical? What does an ordinary client get?', 'This decides the wording that sits beside any result.'],
        ['ad_history', 'Have you ever had an ad rejected or an ad account restricted? What for?'],
      ]],
      ['Your business details', [
        ['legal_name', 'Your registered business name and address.', 'These go in the small print at the bottom of your pages and emails.'],
        ['policies', 'Links to your privacy policy and terms.', 'Say none if you do not have them yet and we will flag it.'],
      ]],
    ],
  },

  // ── Step 4: your tools ─────────────────────────────────────────────────────
  {
    id: 'accounts', step: 4, title: 'Your accounts, at a glance', minutes: 10, who: 'you',
    blurb: 'Which accounts you already have and who looks after them, so nothing holds up the build. Never type a password or a key here. Those go in the connection boxes on the screens before this one.',
    files: 'A list of the tools you use, if you already keep one. Leave out any passwords.',
    sections: [
      ['What you already have', [
        ['have', 'Which of these do you already have an account for?', 'Tick all that apply.', 'ticks', [
          'A webinar platform',
          'Somewhere you keep contacts',
          'A tool that sends your emails',
          'A tool that sends texts',
          'A booking calendar',
          'A way to take payments',
          'An ad account',
          'Your own website address',
        ]],
        ['admin', 'Who is the main admin on each one?', 'You, a team member or an agency. We need that person to add us or to be on hand.'],
        ['missing', 'Which ones do you still need to open?'],
      ]],
      ['Sending emails and texts', [
        ['from_email', 'Which email address should your emails come from?', 'An address at your own website name, not a free one, so they do not land in junk.', 'short'],
        ['from_name', 'What name should people see as the sender?', '', 'short'],
        ['text_number', 'Do you already have a phone number set up to send texts? In which country?', 'Some countries make you register before you can text people, and that can take a week or two.'],
      ]],
      ['Your website and ads', [
        ['domain', 'What website address should your sign-up page live on?', 'For example: training.yourname.com', 'short'],
        ['domain_admin', 'Who can change the settings for your website address?'],
        ['ads_ready', 'If you run ads, is there a payment card on the account and has it run ads before?'],
      ]],
    ],
  },

  // ── Step 5: your look ──────────────────────────────────────────────────────
  {
    id: 'brand_assets', step: 5, title: 'Your brand, logo and photos', minutes: 15, who: 'you',
    blurb: 'Your logo, colours, lettering and photos, so your pages and ads look like you. If you do not have something, say so and we will work around it.',
    files: 'Your logo, two or three good photos of the presenter, and your brand guidelines if you have them. Bigger sets of photos are best shared as a link to a folder.',
    sections: [
      ['Logo', [
        ['logo_have', 'Which versions of your logo do you have?', 'Tick all that apply, then upload them below.', 'ticks', [
          'Full colour logo',
          'A version for dark backgrounds',
          'A version for light backgrounds',
          'A small square icon',
          'A see-through background version',
          'No logo yet',
        ]],
      ]],
      ['Colours and lettering', [
        ['colours', 'What are your brand colours?', 'Give the colour codes if you know them, for example #1E7A4F. Say which one is for buttons.'],
        ['colours_avoid', 'Are there colours you do not want used?'],
        ['fonts', 'What lettering do you use for headlines and for everything else?', 'The names of the fonts, and where they came from if you know.'],
      ]],
      ['Photos', [
        ['photos_have', 'Which photos do you have?', 'Tick all that apply.', 'ticks', [
          'Professional headshots',
          'Relaxed, behind the scenes photos',
          'Speaking or event photos',
          'Team photos',
          'Photos of clients, with their permission',
          'None yet',
        ]],
        ['photos_link', 'Paste a link to a folder of your photos.', '', 'short'],
        ['photo_style', 'What kind of pictures feel like your brand, and what does not?'],
      ]],
      ['Words', [
        ['tagline', 'Do you have a tagline or a line you always use?'],
      ]],
      ['Things you like', [
        ['inspiration', 'Paste three to five websites or brands whose look you like, and what you like about each.', 'One per line.'],
        ['existing', 'Links to anything you already have.', 'Your website, a Canva brand kit, past ads, slide decks.'],
      ]],
    ],
  },
];

const TYPES = ['long', 'short', 'ticks'];
// Optional: each questionnaire can also exist as a Google Doc anyone can view. Put your own
// Doc ids in gdocs.json ({ "offer": "<doc id>", ... }, keyed by questionnaire id) or in the
// QUESTIONNAIRE_DOCS_JSON env var. The page links to <doc>/copy, so people get their own copy
// to type in and the original can never be written over. With no ids, the button is hidden.
let GDOCS = {};
try { GDOCS = require('./gdocs.json'); } catch { GDOCS = {}; }
try { if (process.env.QUESTIONNAIRE_DOCS_JSON) GDOCS = { ...GDOCS, ...JSON.parse(process.env.QUESTIONNAIRE_DOCS_JSON) }; } catch { /* ignore a malformed value */ }
const copyLink = (id) => (GDOCS[id] ? `https://docs.google.com/document/d/${GDOCS[id]}/copy` : '');

/** The catalogue as plain objects, in the order the steps show them. */
const QUESTIONNAIRES = RAW.map(q => ({
  id: q.id, step: q.step, title: q.title, blurb: q.blurb, minutes: q.minutes, who: q.who, repeat: q.repeat || 0, files: q.files, google_doc: copyLink(q.id),
  sections: q.sections.map(([title, questions]) => ({
    title,
    questions: questions.map(([id, text, hint, type, options]) => ({ id, q: text, hint: hint || '', type: TYPES.includes(type) ? type : 'long', options: options || [] })),
  })),
}));

const BY_ID = Object.fromEntries(QUESTIONNAIRES.map(q => [q.id, q]));
const questionsOf = (q) => q.sections.flatMap(s => s.questions);

/** 'offer' → { questionnaire, key: 'offer' } · 'case_study.2' → copy 2 of it · anything else → null */
function resolve(key) {
  const [id, n, extra] = String(key === null || key === undefined ? '' : key).split('.');
  const q = BY_ID[id];
  if (!q || extra !== undefined) return null;
  if (!q.repeat) return n === undefined ? { questionnaire: q, key: id } : null;
  const copy = n === undefined ? 1 : Number(n);
  return Number.isInteger(copy) && copy >= 1 && copy <= q.repeat ? { questionnaire: q, key: `${id}.${copy}` } : null;
}

module.exports = { QUESTIONNAIRES, BY_ID, questionsOf, resolve };
