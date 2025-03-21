const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const wrtc = require('wrtc');
const path = require('path');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server,
    {
        cors: {
            origin: "http://localhost:4200",  // Or use "*" to allow all origins
            methods: ["GET", "POST"],
            credentials: true
        }
    }
);
app.use(cors({
    origin: 'http://localhost:4200'
}))

// Set EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.get('/broadcast', (req, res) => {
    res.render('streamer');
});

app.get('/view', (req, res) => {
    res.render('viewer');
});

app.get('/', (req, res) => {
    res.redirect('/view');
});
const broadcasters = []
const viewers = new Map(); // Map to store viewer connections

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.on('create_room', (roomId) => {
        socket.join(roomId)
        socket.emit("room_created")
    })
    socket.on('start_broadcast', () => {
        socket.emit('start_broadcast')
    })
    socket.on('broadcaster_offer', async(data) => {
           /// create individual peer to server from browser
         createPeerConnection(data.roomId,socket)
        const room = broadcasters.find(room=>room.roomId === data.roomId)
         room.peerConnection.ontrack = (event) => { 
            room.mediaStream.addTrack(event.track)
            console.log(`Broadcaster stream now has ${room.mediaStream.getTracks().length} tracks`);
            console.log(`Track types: ${room.mediaStream.getTracks().map(t => t.kind).join(', ')}`);
         }
         room.peerConnection.onicecandidate = (event) => { 
            if (event.candidate) {
                socket.emit('broadcaster_ice_candidate', event.candidate);
              }
         }
             // Log connection state changes for debugging
      room.peerConnection.onconnectionstatechange = () => {
        console.log(`Broadcaster connection state: ${room.peerConnection.connectionState}`);
        if (room.peerConnection.connectionState === 'connected') {
          console.log('Broadcaster fully connected!');
        }
      };
      
      room.peerConnection.oniceconnectionstatechange = () => {
      
        console.log(`Broadcaster ICE connection state: ${room.peerConnection.iceConnectionState} from ${room.roomId}`);
      };
         await room.peerConnection.setRemoteDescription(data.offer); 
         const answer = await room.peerConnection.createAnswer();
      await room.peerConnection.setLocalDescription(answer); 
        // Send answer back to broadcaster
        socket.emit('broadcaster_answer', room.peerConnection.localDescription);
      
    })
   // Handle ICE candidates from broadcaster
  socket.on('broadcaster_ice_candidate', (data) => {
    
    try {
      const room = broadcasters.find(room=>room.roomId === data.roomId)
       room.peerConnection.addIceCandidate(new wrtc.RTCIceCandidate(data.candidate));
    } catch (error) {
      console.error('Error adding broadcaster ICE candidate:', error);
    }
  });
  socket.on('stop',(roomId)=>{
    let index = broadcasters.findIndex(obj=>obj.roomId === roomId)
    broadcasters[index].peerConnection.close()
    broadcasters.splice(index,1)
    console.log(broadcasters)
  })
  socket.on('join',(roomId)=>{
    socket.join(roomId)
    io.to(roomId).emit('user_connected',roomId)
  })
  // Handle viewer connection requests
  socket.on('viewer_request', async (roomId) => {  
    try {
      // Create a new RTCPeerConnection for this viewer
      
      const viewerPC = new wrtc.RTCPeerConnection({
        iceServers: [
          {
            urls: "stun:stun.relay.metered.ca:80",
          },
          {
            urls: "turn:global.relay.metered.ca:80",
            username: "836c17083ecba16b626af6f7",
            credential: "j/Du96pT1PjJXgP/",
          },
          {
            urls: "turn:global.relay.metered.ca:80?transport=tcp",
            username: "836c17083ecba16b626af6f7",
            credential: "j/Du96pT1PjJXgP/",
          },
          {
            urls: "turn:global.relay.metered.ca:443",
            username: "836c17083ecba16b626af6f7",
            credential: "j/Du96pT1PjJXgP/",
          },
          {
            urls: "turns:global.relay.metered.ca:443?transport=tcp",
            username: "836c17083ecba16b626af6f7",
            credential: "j/Du96pT1PjJXgP/",
          },
      ],
      });
      
      // Add this viewer to our map
    viewers.set(socket.id, viewerPC);
      
      // Handle ICE candidate events

      viewerPC.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('viewer_ice_candidate', event.candidate);
        }
      };
      
      // Log connection state changes for debugging
      viewerPC.onconnectionstatechange = () => {
        console.log(`Viewer ${socket.id} connection state: ${viewerPC.connectionState}`);
        if (viewerPC.connectionState === 'connected') {
          console.log(`Viewer ${socket.id} fully connected!`);
        }
      };
      
      viewerPC.oniceconnectionstatechange = () => {
        console.log(`Viewer ${socket.id} ICE connection state: ${viewerPC.iceConnectionState}`);
      };
      
      // Check if we have tracks to send
      let tracksAdded = false;
      const broadcaster = broadcasters.find(obj=>obj.roomId)
    
      if (broadcaster && broadcaster.mediaStream.getTracks().length > 0) {
        console.log(`Adding ${ broadcaster.mediaStream.getTracks().length} tracks to viewer ${socket.id}`);
        
        // Important: Clone the MediaStream to ensure proper handling
        const viewerStream = new wrtc.MediaStream();
        
        // Add all tracks from broadcaster stream to viewer stream and peer connection
        broadcaster.mediaStream.getTracks().forEach(track => {
          console.log(`Adding ${track.kind} track to viewer ${socket.id}`);
          viewerPC.addTrack(track, viewerStream);
          tracksAdded = true;
        });
      }
      
      if (!tracksAdded) {
        console.warn('No tracks available to add to the viewer connection');
        socket.emit('error', { message: 'No broadcast stream available yet. Please try again in a moment.' });
        return;
      }
      
      // Create offer for viewer
      const offer = await viewerPC.createOffer();
      await viewerPC.setLocalDescription(offer);
      
      // Send offer to viewer
      socket.emit('viewer_offer', viewerPC.localDescription);
    } catch (error) {
      console.error('Error setting up viewer connection:', error);
      socket.emit('error', { message: 'Failed to establish viewer connection' });
    }
  });
// Handle answer from viewer
socket.on('viewer_answer', async (description) => {
    const viewerPC = viewers.get(socket.id);
    if (!viewerPC) return;
    
    try {
      await viewerPC.setRemoteDescription(description);
      console.log(`Viewer ${socket.id} answer processed successfully`);
    } catch (error) {
      console.error('Error setting viewer remote description:', error);
    }
  });

  // Handle ICE candidates from viewer
  socket.on('viewer_ice_candidate', (candidate) => {
    const viewerPC = viewers.get(socket.id);
    if (!viewerPC) return;
    
    try {
      viewerPC.addIceCandidate(new wrtc.RTCIceCandidate(candidate));
    } catch (error) {
      console.error('Error adding viewer ICE candidate:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('A user disconnected:', socket.id);
  });
}) 
function createPeerConnection(roomId,socket) {
    const peerConnection = new wrtc.RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.stunprotocol.org:3478' },
            { urls: 'stun:stun.l.google.com:19302' }
        ]
    });
    const room = {
        roomId:roomId,
        broadcasterId:socket.id,
        mediaStream:new wrtc.MediaStream(),
        peerConnection:peerConnection 
      }
      broadcasters.push(room)
} 

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Broadcast page: http://localhost:${PORT}/broadcast`);
    console.log(`Viewer page: http://localhost:${PORT}/view`);
});