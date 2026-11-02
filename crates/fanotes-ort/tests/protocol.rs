use std::io::Cursor;

use fanotes_ort::{
    protocol::{read_frame, write_frame, Frame, Reply, Request, MAX_HEADER_BYTES},
    Error, Prediction, ENGINE,
};

fn request(width: usize, threads: usize) -> Request {
    Request {
        id: "line-1".to_owned(),
        width,
        height: 128,
        threads,
        input_name: "x".to_owned(),
        output_name: "probabilities".to_owned(),
        input: (0..width * 128).map(|index| index as f32 / 7.0).collect(),
    }
}

fn header(json: &str, payload: Vec<u8>) -> Frame {
    Frame {
        header: json.as_bytes().to_vec(),
        payload,
    }
}

#[test]
fn frames_round_trip_and_end_cleanly() {
    let mut stream = Vec::new();
    let first = request(32, 2).encode();
    let second = Reply::error("x", &Error::InvalidInput);
    write_frame(&mut stream, &first.header, &first.payload).unwrap();
    write_frame(&mut stream, &second.header, &second.payload).unwrap();
    let mut reader = Cursor::new(stream);
    assert_eq!(read_frame(&mut reader).unwrap(), Some(first));
    assert_eq!(read_frame(&mut reader).unwrap(), Some(second));
    assert_eq!(read_frame(&mut reader).unwrap(), None);
}

#[test]
fn truncated_or_oversized_frames_are_errors() {
    let frame = request(32, 1).encode();
    let mut stream = Vec::new();
    write_frame(&mut stream, &frame.header, &frame.payload).unwrap();
    for cut in [2, 4, 10, stream.len() - 1] {
        assert!(
            read_frame(&mut Cursor::new(&stream[..cut])).is_err(),
            "cut at {cut}"
        );
    }
    let mut oversized = ((MAX_HEADER_BYTES + 1) as u32).to_le_bytes().to_vec();
    oversized.resize(MAX_HEADER_BYTES + 16, b' ');
    assert!(read_frame(&mut Cursor::new(oversized)).is_err());
    assert!(read_frame(&mut Cursor::new(0u32.to_le_bytes().to_vec())).is_err());
}

#[test]
fn a_line_request_round_trips_bit_for_bit() {
    let line = request(333, 4);
    let parsed = Request::parse(&line.encode()).unwrap();
    assert_eq!(parsed, line);
    assert_eq!(parsed.input.len(), 128 * 333);
}

#[test]
fn requests_the_worker_refused_are_refused_with_their_id() {
    let payload = |width: usize, height: usize| vec![0u8; width * height * 4];
    let cases = [
        (
            r#"{"id":"a","width":15,"height":128,"threads":1}"#,
            payload(15, 128),
        ),
        (
            r#"{"id":"a","width":4097,"height":128,"threads":1}"#,
            payload(4097, 128),
        ),
        (
            r#"{"id":"a","width":32,"height":100,"threads":1}"#,
            payload(32, 100),
        ),
        (
            r#"{"id":"a","width":32,"height":257,"threads":1}"#,
            payload(32, 257),
        ),
        (
            r#"{"id":"a","width":32,"height":64,"threads":1}"#,
            payload(32, 128),
        ),
        (
            r#"{"id":"a","width":32,"height":128,"threads":0}"#,
            payload(32, 128),
        ),
        (
            r#"{"id":"a","width":32,"height":128,"threads":5}"#,
            payload(32, 128),
        ),
        (
            r#"{"id":"a","width":32,"height":128,"threads":1}"#,
            payload(33, 128),
        ),
        (
            r#"{"id":"a","width":32,"height":128,"threads":1,"input_name":"a b"}"#,
            payload(32, 128),
        ),
        (
            r#"{"id":"a","width":32,"height":128,"threads":1,"extra":true}"#,
            payload(32, 128),
        ),
        (
            r#"{"id":"a","width":32.5,"height":128,"threads":1}"#,
            payload(32, 128),
        ),
    ];
    for (json, payload) in cases {
        let (id, error) = Request::parse(&header(json, payload)).unwrap_err();
        assert_eq!(id, "a", "{json}");
        assert!(matches!(error, Error::InvalidInput), "{json}");
    }
    let long = "x".repeat(97);
    let (id, _) = Request::parse(&header(
        &format!(r#"{{"id":"{long}","width":32,"height":128,"threads":1}}"#),
        payload(32, 128),
    ))
    .unwrap_err();
    assert_eq!(id, long);
    let (id, _) = Request::parse(&header("{not json", Vec::new())).unwrap_err();
    assert_eq!(id, "");
    let (id, _) = Request::parse(&header(
        r#"{"id":7,"width":32,"height":128,"threads":1}"#,
        payload(32, 128),
    ))
    .unwrap_err();
    assert_eq!(id, "", "a non-string id is not echoed");
}

#[test]
fn replies_round_trip() {
    let prediction = Prediction {
        probabilities: vec![0.25, 0.5, 0.25, 1.0, 0.0, 0.0],
        dims: vec![1, 2, 3],
    };
    match Reply::parse(&Reply::prediction("line-1", &prediction)).unwrap() {
        Reply::Prediction {
            id,
            prediction: decoded,
            engine,
        } => {
            assert_eq!((id.as_str(), engine.as_str()), ("line-1", ENGINE));
            assert_eq!(decoded, prediction);
        }
        other => panic!("{other:?}"),
    }
    match Reply::parse(&Reply::error("line-2", &Error::CorruptModel)).unwrap() {
        Reply::Error { id, message } => {
            assert_eq!(id, "line-2");
            assert_eq!(message, "Das native Handschriftmodell ist beschädigt.");
        }
        other => panic!("{other:?}"),
    }
    let mut short = Reply::prediction("line-3", &prediction);
    short.payload.pop();
    assert!(Reply::parse(&short).is_err());
}

#[test]
fn long_runtime_errors_are_cut_to_what_main_cjs_kept() {
    let error = Error::Inference("x".repeat(5_000));
    match Reply::parse(&Reply::error("line", &error)).unwrap() {
        Reply::Error { message, .. } => assert_eq!(message.chars().count(), 500),
        other => panic!("{other:?}"),
    }
}
