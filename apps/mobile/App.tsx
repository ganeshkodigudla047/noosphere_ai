import { useRef, useState } from "react";
import { Animated, PanResponder, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { fixtureNodes, type KnowledgeNode } from "@noosphere/domain";

export default function App() {
  const [selected, setSelected] = useState<KnowledgeNode>();
  return <SafeAreaView style={s.root}><StatusBar style="light" />{selected ? <Reader node={selected} onBack={() => setSelected(undefined)} /> : <Home onSelect={setSelected} />}</SafeAreaView>;
}

function Home({ onSelect }: { onSelect: (node: KnowledgeNode) => void }) {
  return <View style={s.home}>
    <View style={s.header}><Text style={s.brand}>◎ noosphere</Text><View style={s.avatar}><Text>AS</Text></View></View>
    <Text style={s.eyebrow}>YOUR LEARNING UNIVERSE</Text><Text style={s.title}>See how everything you learn connects.</Text>
    <TextInput style={s.search} placeholder="Find a topic or idea…" placeholderTextColor="#71877d" />
    <View style={s.globe}>{fixtureNodes.map((node,index)=><Pressable key={node.id} onPress={()=>onSelect(node)} style={[s.node,{backgroundColor:node.color,left:`${18+(index*13)%68}%`,top:`${18+(index*23)%65}%`}]}/>)}</View>
    <Text style={s.hint}>Tap a glowing node to focus</Text>
  </View>;
}

function Reader({ node, onBack }: { node: KnowledgeNode; onBack: () => void }) {
  const sheetY=useRef(new Animated.Value(360)).current;
  const pan=useRef(PanResponder.create({onMoveShouldSetPanResponder:(_,g)=>Math.abs(g.dy)>8,onPanResponderMove:(_,g)=>sheetY.setValue(Math.max(0,Math.min(360,g.dy))),onPanResponderRelease:(_,g)=>Animated.spring(sheetY,{toValue:g.dy < -60 ? 0:360,useNativeDriver:true}).start()})).current;
  return <View style={s.reader}>
    <Pressable onPress={onBack}><Text style={s.back}>‹ Back to globe</Text></Pressable>
    <ScrollView contentContainerStyle={s.article}><Text style={s.pageMeta}>{node.subject.toUpperCase()} · PAGE {node.pageNumber}</Text><Text style={s.readerTitle}>{node.label}</Text><Text style={s.lead}>{node.summary}</Text><View style={s.rule}/><Text style={s.body}>The ingestion pipeline will place extracted page content here. This shell already preserves the node-to-reader contract shared with the web application.</Text><Text style={s.subhead}>Spatial context</Text><Text style={s.body}>The selected page remains anchored to its position while the student reads and asks questions.</Text></ScrollView>
    <Pressable style={s.ask} onPress={()=>Animated.spring(sheetY,{toValue:0,useNativeDriver:true}).start()}><Text style={s.askText}>✦ Ask about this page</Text></Pressable>
    <Animated.View {...pan.panHandlers} style={[s.sheet,{transform:[{translateY:sheetY}]}]}><View style={s.handle}/><Text style={s.sheetTitle}>✦ Page companion</Text><Text style={s.sheetCopy}>Answers will be grounded only in this page.</Text><View style={s.chatInput}><TextInput placeholder="Ask a doubt…" placeholderTextColor="#71877d" style={{flex:1}}/><Text>↑</Text></View></Animated.View>
  </View>;
}

const s=StyleSheet.create({
  root:{flex:1,backgroundColor:"#07100d"},home:{flex:1,padding:22},header:{flexDirection:"row",justifyContent:"space-between",alignItems:"center"},brand:{color:"#effaf4",fontSize:18,fontWeight:"700"},avatar:{width:36,height:36,borderRadius:18,backgroundColor:"#98e8c1",alignItems:"center",justifyContent:"center"},eyebrow:{color:"#79d9ac",fontSize:11,letterSpacing:2,marginTop:45},title:{color:"#f0f8f3",fontSize:38,lineHeight:43,fontWeight:"600",marginTop:12},search:{color:"white",backgroundColor:"#12221d",borderColor:"#314d40",borderWidth:1,borderRadius:15,padding:15,marginTop:24},globe:{alignSelf:"center",width:280,height:280,borderRadius:140,borderWidth:1,borderColor:"#365849",backgroundColor:"#10231d",marginTop:28,position:"relative",shadowColor:"#6ed5a3",shadowRadius:35,shadowOpacity:.16},node:{position:"absolute",width:13,height:13,borderRadius:8,shadowColor:"white",shadowOpacity:.9,shadowRadius:8},hint:{color:"#698078",textAlign:"center",fontSize:12,marginTop:18},reader:{flex:1,backgroundColor:"#eef1ec",paddingTop:12},back:{color:"#dce9e2",backgroundColor:"#0b1512",padding:18},article:{padding:24,paddingBottom:120},pageMeta:{fontSize:11,color:"#547063",letterSpacing:1.3},readerTitle:{fontSize:42,fontWeight:"700",color:"#18231e",marginTop:16},lead:{fontSize:18,lineHeight:29,color:"#53645c",marginTop:10},rule:{height:1,backgroundColor:"#cad3ce",marginVertical:28},body:{fontSize:16,lineHeight:28,color:"#3d4b44"},subhead:{fontSize:22,fontWeight:"600",color:"#18231e",marginTop:30,marginBottom:10},ask:{position:"absolute",right:18,bottom:22,backgroundColor:"#246746",padding:15,borderRadius:28},askText:{color:"white",fontWeight:"600"},sheet:{position:"absolute",left:0,right:0,bottom:0,height:420,backgroundColor:"#f9fbf8",borderTopLeftRadius:24,borderTopRightRadius:24,padding:24,shadowColor:"#000",shadowOpacity:.25,shadowRadius:28},handle:{width:45,height:5,borderRadius:4,backgroundColor:"#cad3ce",alignSelf:"center",marginBottom:22},sheetTitle:{fontSize:18,fontWeight:"700",color:"#26362e"},sheetCopy:{color:"#607068",marginTop:10},chatInput:{position:"absolute",bottom:28,left:24,right:24,flexDirection:"row",borderWidth:1,borderColor:"#cbd5cf",borderRadius:14,padding:14}
});
